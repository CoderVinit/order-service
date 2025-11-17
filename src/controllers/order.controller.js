import axios from "axios";
import crypto from "crypto";
import DeliveryAssignment from "../models/deliveryAssignment.model.js";
import Order from "../models/order.model.js";
import { getIO } from "../socket/socket.js";

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || "http://localhost:3001";
const SHOP_SERVICE_URL = process.env.SHOP_SERVICE_URL || "http://localhost:3002";
const NOTIFICATION_SERVICE_URL = process.env.NOTIFICATION_SERVICE_URL || "http://localhost:3007";

// Helper function to call notification service
const sendEmail = async (endpoint, data) => {
  try {
    const response = await axios.post(`${NOTIFICATION_SERVICE_URL}/api/notifications/${endpoint}`, data);
    return response.data;
  } catch (error) {
    console.error(`Error sending email to ${endpoint}:`, error.message);
  }
};

export const placeOrder = async (req, res) => {
  try {
    const { cartItems, paymentMethod, deliveryAddress, totalAmount, payment } = req.body;
    if (!cartItems || cartItems.length === 0) {
      return res.status(400).json({ success: false, message: "Cart is empty" });
    }
    if (
      !deliveryAddress ||
      !deliveryAddress.text ||
      !deliveryAddress.latitude ||
      !deliveryAddress.longitude
    ) {
      return res
        .status(400)
        .json({ success: false, message: "Delivery address is required" });
    }

    const groupItemsByShop = {};

    // Normalize and group items by shop id
    cartItems.forEach((item) => {
      const shopId = typeof item.shop === "string" ? item.shop : (item.shop?._id || item.shop);
      if (!shopId) {
        throw new Error("Invalid cart item: missing shop id");
      }
      const key = shopId.toString();
      if (!groupItemsByShop[key]) {
        groupItemsByShop[key] = [];
      }
      groupItemsByShop[key].push(item);
    });

    // Get shop details from shop service
    const shopOrder = await Promise.all(
      Object.keys(groupItemsByShop).map(async (shopId) => {
        try {
          const shopResponse = await axios.get(`${SHOP_SERVICE_URL}/api/shops/${shopId}`);
          const shop = shopResponse.data.data;
          
          if (!shop) {
            throw new Error("Shop not found");
          }
          
          const items = groupItemsByShop[shopId];
          const subTotal = items.reduce(
            (acc, item) => acc + Number(item.price) * Number(item.quantity),
            0
          );

          return {
            shop: shop._id,
            owner: shop.owner,
            subtotal: subTotal,
            shopOrderItems: items.map((i) => ({
              item: i.id || i._id,
              name: i.name,
              quantity: i.quantity,
              price: i.price,
              image: i.image,
              foodType: i.foodType,
            })),
          };
        } catch (error) {
          console.error("Error fetching shop:", error.message);
          throw new Error(`Failed to fetch shop ${shopId}`);
        }
      })
    );

    // Prepare payment details
    let paymentStatus = "pending";
    let paymentDetails = undefined;

    if (paymentMethod === "online") {
      // Validate razorpay payment details and signature
      const reqOrderId = payment?.orderId || payment?.razorpay_order_id;
      const reqPaymentId = payment?.paymentId || payment?.razorpay_payment_id;
      const reqSignature = payment?.signature || payment?.razorpay_signature;
      if (!reqOrderId || !reqPaymentId || !reqSignature) {
        return res.status(400).json({
          success: false,
          message: "Payment details are required for online payments",
        });
      }
      const secret = process.env.RAZORPAY_KEY_SECRET || process.env.RAZORPAY_SECRET_KEY;
      if (!secret) {
        return res.status(500).json({ success: false, message: "Payment configuration missing" });
      }
      const hmac = crypto
        .createHmac("sha256", secret)
        .update(`${reqOrderId}|${reqPaymentId}`)
        .digest("hex");
      if (hmac !== reqSignature) {
        return res.status(400).json({ success: false, message: "Invalid payment signature" });
      }

      paymentStatus = "paid";
      paymentDetails = {
        provider: payment?.provider || "razorpay",
        orderId: reqOrderId,
        paymentId: reqPaymentId,
        signature: reqSignature,
        currency: payment?.currency || "INR",
        amount: payment?.amount,
        receipt: payment?.receipt,
      };
    }

    const newOrder = await Order.create({
      userId: req.userId,
      paymentMethod,
      paymentStatus,
      payment: paymentDetails,
      deliveryAddress,
      totalAmount,
      shopOrder,
    });

    const io = getIO();
    if (io) {
      const orderId = newOrder._id.toString();
      const userId = req.userId?.toString?.() || req.userId;
      const userRefreshPayload = { scope: "user", orderId, userId };
      io.to(`user:${userId}`).emit("orders:refresh", userRefreshPayload);
      io.emit("orders:refresh", userRefreshPayload);

      newOrder.shopOrder.forEach((entry) => {
        const ownerId = entry?.owner?.toString?.() || entry?.owner?._id?.toString?.();
        if (ownerId) {
          console.log("Emitting orders:refresh for owner", { ownerId, orderId });
          const payload = { scope: "owner", orderId, ownerId };
          io.to(`owner:${ownerId}`).emit("orders:refresh", payload);
          io.emit("orders:refresh", payload);
        }
      });
    }

    return res.status(201).json({
      success: true,
      message: "Order placed successfully",
      order: newOrder,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};

export const getMyOrders = async (req, res) => {
  try {
    const orders = await Order.find({ userId: req.userId })
      .sort({ createdAt: -1 });
    return res.status(200).json({ success: true, data: orders });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};

export const getOwnerOrders = async (req, res) => {
  try {
    const ownerId = req.userId;
    let orders = await Order.find({ "shopOrder.owner": ownerId })
      .sort({ createdAt: -1 });

    // Filter each order's shopOrder array to only include entries belonging to this owner
    orders = orders.map((order) => {
      const filteredShopOrder = order.shopOrder.filter((so) => {
        const id = so.owner && so.owner._id ? so.owner._id : so.owner;
        return id?.toString() === ownerId.toString();
      });
      const totalAmount = filteredShopOrder.reduce((acc, so) => {
        return acc + so.subtotal;
      }, 0);
      return {
        ...order.toObject(),
        totalAmount: totalAmount < 500 ? totalAmount + 50 : totalAmount,
        shopOrder: filteredShopOrder,
      };
    });

    return res.status(200).json({ success: true, orders });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};

export const updateOrderStatus = async (req, res) => {
  try {
    const { orderId, shopOrderId } = req.params;
    const { status } = req.body;
    
    if (!orderId || !shopOrderId || !status) {
      return res.status(400).json({
        success: false,
        message: "orderId, shopOrderId and status are required",
      });
    }
    
    const order = await Order.findById(orderId);
    if (!order) {
      return res
        .status(404)
        .json({ success: false, message: "Order not found" });
    }
    
    let shopOrder = order.shopOrder.find(
      (so) => so._id.toString() === shopOrderId
    );

    if (!shopOrder) {
      return res
        .status(404)
        .json({ success: false, message: "Shop order not found" });
    }
    
    shopOrder.status = status;

    let deliveryBoyPayload = [];
    let deliveryAssignment = null;
    
    if (status === "out-for-delivery" && !shopOrder.assignment) {
      const { longitude, latitude } = order.deliveryAddress;
      
      try {
        // Get nearby delivery boys from auth service
        const nearbyResponse = await axios.post(`${AUTH_SERVICE_URL}/api/auth/nearby-delivery-boys`, {
          longitude,
          latitude,
          maxDistance: 5000
        });
        
        let nearestDeliveryPerson = nearbyResponse.data.data || [];
        
        // Fallback to 20km if none found
        if (nearestDeliveryPerson.length === 0) {
          const fallbackResponse = await axios.post(`${AUTH_SERVICE_URL}/api/auth/nearby-delivery-boys`, {
            longitude,
            latitude,
            maxDistance: 20000
          });
          nearestDeliveryPerson = fallbackResponse.data.data || [];
        }

        const nearByIds = nearestDeliveryPerson.map((person) => person._id);
        
        // Find busy delivery boys
        const busyDeliveryBoys = await DeliveryAssignment.find({
          assignedTo: { $in: nearByIds },
          status: { $in: ["assigned", "picked-up", "en-route"] },
        }).distinct("assignedTo");
        
        const busySet = new Set(busyDeliveryBoys.map((id) => id.toString()));
        const availableBoys = nearestDeliveryPerson.filter(
          (person) => !busySet.has(person._id.toString())
        );
        const candidates = availableBoys.map((b) => b._id);

        deliveryAssignment = await DeliveryAssignment.create({
          order: order._id,
          shop: shopOrder.shop,
          shopOrderId: shopOrder._id,
          broadcastedTo: candidates,
        });

        shopOrder.assignment = deliveryAssignment._id;
        shopOrder.assignedDeliveryBoy = deliveryAssignment.assignedTo;

        deliveryBoyPayload = availableBoys.map((b) => ({
          id: b._id,
          name: b.fullName,
          email: b.email,
          phone: b.mobile,
          latitude: b.location?.coordinates[1],
          longitude: b.location?.coordinates[0],
        }));
      } catch (error) {
        console.error("Error finding delivery boys:", error.message);
      }
    }
    
    await order.save();
    
    if (status === "preparing") {
      // Get user email from auth service
      try {
        const userResponse = await axios.get(`${AUTH_SERVICE_URL}/api/auth/user/${order.userId}`);
        const userEmail = userResponse.data.data?.email;
        if (userEmail) {
          sendEmail("order-status", { email: userEmail, status: shopOrder.status });
        }
      } catch (error) {
        console.error("Error fetching user email:", error.message);
      }
    }

    const updatedShopOrder = order.shopOrder.find((o) => o._id.toString() === shopOrderId);

    const io = getIO();
    if (io && updatedShopOrder) {
      const orderId = order._id.toString();
      const shopOrderKey = updatedShopOrder._id.toString();
      const userId = order.userId?.toString?.();
      const ownerId = updatedShopOrder.owner?.toString?.();
      const assignedDeliveryId = updatedShopOrder.assignedDeliveryBoy?.toString?.();
      
      const statusMessages = {
        pending: "Order placed",
        preparing: "Order is being prepared",
        "out-for-delivery": "Order is out for delivery",
        delivered: "Order delivered",
        cancelled: "Order cancelled"
      };
      
      const payload = {
        orderId,
        shopOrderId: shopOrderKey,
        status: updatedShopOrder.status,
        assignmentId: updatedShopOrder.assignment?.toString?.() || null,
        assignedDeliveryBoy: assignedDeliveryId,
        userId,
        ownerId,
        message: statusMessages[updatedShopOrder.status] || "Order updated"
      };

      io.to(`order:${orderId}`).emit("order:status", payload);

      if (userId) {
        io.to(`user:${userId}`).emit("order:status", payload);
        io.to(`user:${userId}`).emit("orders:refresh", { scope: "user", orderId, userId });
        io.emit("orders:refresh", { scope: "user", orderId, userId });
      }

      if (ownerId) {
        io.to(`owner:${ownerId}`).emit("order:status", payload);
        io.to(`owner:${ownerId}`).emit("orders:refresh", { scope: "owner", orderId, ownerId });
        io.emit("orders:refresh", { scope: "owner", orderId, ownerId });
      }

      if (assignedDeliveryId) {
        io.to(`delivery:${assignedDeliveryId}`).emit("order:status", payload);
        io.to(`delivery:${assignedDeliveryId}`).emit("orders:refresh", { scope: "delivery", orderId });
      }

      if (deliveryAssignment && deliveryBoyPayload.length) {
        const assignmentPayload = {
          orderId,
          shopOrderId: shopOrderKey,
          assignmentId: deliveryAssignment._id.toString(),
          shop: {
            id: updatedShopOrder.shop?.toString?.(),
          },
          deliveryAddress: order.deliveryAddress,
          subtotal: updatedShopOrder.subtotal,
          items: updatedShopOrder.shopOrderItems?.map((item) => ({
            name: item.name,
            quantity: item.quantity,
            price: item.price
          })) || []
        };

        deliveryBoyPayload.forEach((boy) => {
          const deliveryBoyId = boy.id?.toString?.();
          if (deliveryBoyId) {
            io.to(`delivery:${deliveryBoyId}`).emit("delivery:assignment", assignmentPayload);
          }
        });
      }
    }

    return res.status(200).json({
      success: true,
      message: "Order status updated successfully",
      data: {
        shopOrder: updatedShopOrder,
        assignedDeliveryBoy: updatedShopOrder?.assignedDeliveryBoy,
        availableDeliveryBoys: deliveryBoyPayload,
        assignment: updatedShopOrder?.assignment,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};

export const getAssignmentsOfDeliveryBoy = async (req, res) => {
  try {
    const deliveryBoyId = req.userId;
    const assignments = await DeliveryAssignment.find({
      broadcastedTo: deliveryBoyId,
      status: "broadcasted",
    })
      .populate("order");

    const formated = assignments.map((o) => ({
      assignmentId: o._id,
      orderId: o.order._id,
      shopId: o.shop,
      items:
        o.order.shopOrder.find(
          (so) => so._id.toString() === o.shopOrderId.toString()
        )?.shopOrderItems || [],
      subtotal: o.order.totalAmount,
      deliveryAddress: o.order.deliveryAddress,
    }));

    return res.status(200).json({ success: true, data: formated });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};

export const acceptOrder = async (req, res) => {
  try {
    const deliveryBoyId = req.userId;
    const { assignmentId } = req.params;
    
    if (!assignmentId) {
      return res
        .status(400)
        .json({ success: false, message: "assignmentId is required" });
    }
    
    const assignment = await DeliveryAssignment.findById(assignmentId);
    if (!assignment) {
      return res
        .status(404)
        .json({ success: false, message: "Assignment not found" });
    }
    
    if (assignment.status !== "broadcasted") {
      return res
        .status(400)
        .json({
          success: false,
          message: "Assignment is not in broadcasted state",
        });
    }

    if (
      !assignment.broadcastedTo
        .map((id) => id.toString())
        .includes(deliveryBoyId.toString())
    ) {
      return res
        .status(403)
        .json({
          success: false,
          message: "You are not authorized to accept this assignment",
        });
    }

    const previousBroadcast = assignment.broadcastedTo?.map((id) => id.toString()) || [];
    assignment.status = "assigned";
    assignment.assignedTo = deliveryBoyId;
    assignment.acceptedAt = new Date();
    assignment.broadcastedTo = [];
    await assignment.save();

    const order = await Order.findById(assignment.order);
    const shopOrder = order.shopOrder.find(
      (so) => so._id.toString() === assignment.shopOrderId.toString()
    );
    shopOrder.assignedDeliveryBoy = deliveryBoyId;
    await order.save();

    const io = getIO();
    if (io) {
      const orderId = order._id.toString();
      const shopOrderId = assignment.shopOrderId.toString();
      const userId = order.userId?.toString?.();
      const ownerId = shopOrder.owner?.toString?.();
      const assignedDeliveryId = deliveryBoyId.toString();
      
      const payload = {
        orderId,
        shopOrderId,
        status: shopOrder.status,
        assignmentId: assignment._id.toString(),
        assignedDeliveryBoy: assignedDeliveryId,
        userId,
        ownerId,
        message: "Delivery partner assigned"
      };

      io.to(`order:${orderId}`).emit("order:status", payload);

      if (userId) {
        io.to(`user:${userId}`).emit("order:status", payload);
        io.to(`user:${userId}`).emit("orders:refresh", { scope: "user", orderId, userId });
        io.emit("orders:refresh", { scope: "user", orderId, userId });
      }

      if (ownerId) {
        io.to(`owner:${ownerId}`).emit("order:status", payload);
        io.to(`owner:${ownerId}`).emit("orders:refresh", { scope: "owner", orderId, ownerId });
        io.emit("orders:refresh", { scope: "owner", orderId, ownerId });
      }

      if (assignedDeliveryId) {
        io.to(`delivery:${assignedDeliveryId}`).emit("order:status", payload);
        io.to(`delivery:${assignedDeliveryId}`).emit("orders:refresh", { scope: "delivery", orderId });
      }

      previousBroadcast
        .filter((id) => id !== assignedDeliveryId)
        .forEach((id) => {
          io.to(`delivery:${id}`).emit("delivery:assignment-closed", {
            assignmentId: assignment._id.toString(),
            orderId,
            shopOrderId
          });
        });
    }

    return res
      .status(200)
      .json({
        success: true,
        message: "Order accepted successfully",
        data: { assignmentId: assignment._id, orderId: order._id },
      });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};

export const currentOrder = async (req, res) => {
  try {
    const deliveryBoyId = req.userId;

    const assignment = await DeliveryAssignment.findOne({
      assignedTo: deliveryBoyId,
      status: "assigned",
    }).populate("order");

    if (!assignment) {
      return res
        .status(404)
        .json({ success: false, message: "No current assignment found" });
    }

    if (!assignment.order) {
      return res
        .status(404)
        .json({ success: false, message: "Order details not found" });
    }

    const shopOrder = assignment.order.shopOrder.find(
      (so) => so._id.toString() === assignment.shopOrderId.toString()
    );
    
    if (!shopOrder) {
      return res
        .status(404)
        .json({ success: false, message: "Shop order details not found" });
    }

    // Get delivery boy location from auth service
    let deliveryBoyLocation = { lat: null, long: null };
    try {
      const dbResponse = await axios.get(`${AUTH_SERVICE_URL}/api/auth/user/${deliveryBoyId}`);
      const dbUser = dbResponse.data.data;
      if (dbUser?.location?.coordinates) {
        deliveryBoyLocation.lat = dbUser.location.coordinates[1];
        deliveryBoyLocation.long = dbUser.location.coordinates[0];
      }
    } catch (error) {
      console.error("Error fetching delivery boy location:", error.message);
    }

    const customerLocation = { lat: null, long: null };
    if (assignment.order.deliveryAddress) {
      customerLocation.lat = assignment.order.deliveryAddress.latitude;
      customerLocation.long = assignment.order.deliveryAddress.longitude;
    }

    return res.status(200).json({
      success: true,
      data: {
        _id: assignment._id,
        userId: assignment.order.userId,
        shop: assignment.shop,
        shopOrder,
        deliveryAddress: assignment.order.deliveryAddress,
        deliveryBoyLocation,
        customerLocation,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};

export const markOrderAsDelivered = async (req, res) => {
  try {
    const deliveryBoyId = req.userId;
    const assignment = await DeliveryAssignment.findOne({
      assignedTo: deliveryBoyId,
      status: "assigned",
    }).populate("order");

    if (!assignment) {
      return res
        .status(404)
        .json({ success: false, message: "No current assignment found" });
    }

    const userId = assignment.order.userId;
    
    // Generate OTP
    const otp = Math.floor(1000 + Math.random() * 9000).toString();
    
    // Update user OTP via auth service
    try {
      await axios.post(`${AUTH_SERVICE_URL}/api/auth/update-otp`, {
        userId,
        otp,
        expiresIn: 10 * 60 * 1000 // 10 minutes
      });
    } catch (error) {
      console.error("Error updating user OTP:", error.message);
      return res.status(500).json({ success: false, message: "Failed to generate OTP" });
    }

    // Get user email
    try {
      const userResponse = await axios.get(`${AUTH_SERVICE_URL}/api/auth/user/${userId}`);
      const userEmail = userResponse.data.data?.email;
      if (userEmail) {
        sendEmail("order-delivered", { email: userEmail, otp });
      }
    } catch (error) {
      console.error("Error sending delivery OTP email:", error.message);
    }

    res.status(200).json({ success: true, message: "OTP sent successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};

export const getOrderById = async (req, res) => {
  try {
    const { orderId } = req.params;
    if (!orderId) {
      return res.status(400).json({ success: false, message: "orderId is required" });
    }

    const order = await Order.findById(orderId).lean();
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    return res.status(200).json({ success: true, data: order });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};

export const orderDelivered = async (req, res) => {
  try {
    const { otp } = req.body;
    const deliveryBoyId = req.userId;

    const assignment = await DeliveryAssignment.findOne({
      assignedTo: deliveryBoyId,
      status: "assigned",
    }).populate("order");

    if (!assignment) {
      return res
        .status(404)
        .json({ success: false, message: "No current assignment found" });
    }

    const userId = assignment.order.userId;
    
    // Verify OTP via auth service
    try {
      const verifyResponse = await axios.post(`${AUTH_SERVICE_URL}/api/auth/verify-delivery-otp`, {
        userId,
        otp
      });
      
      if (!verifyResponse.data.success) {
        return res.status(400).json({ success: false, message: verifyResponse.data.message || "Invalid OTP" });
      }
    } catch (error) {
      return res.status(400).json({ success: false, message: "Invalid or expired OTP" });
    }

    // Mark assignment as completed
    assignment.status = "completed";
    assignment.completedAt = new Date();
    assignment.assignedTo = null;
    await assignment.save();

    const order = await Order.findById(assignment.order._id);
    const shopOrder = order.shopOrder.find(
      (so) => so._id.toString() === assignment.shopOrderId.toString()
    );
    shopOrder.status = "delivered";
    shopOrder.assignedDeliveryBoy = null;
    await order.save();

    const io = getIO();
    if (io) {
      const orderId = order._id.toString();
      const shopOrderId = shopOrder._id.toString();
      const userIdStr = order.userId?.toString?.();
      const ownerId = shopOrder.owner?.toString?.();
      const deliveryBoyIdStr = deliveryBoyId ? deliveryBoyId.toString() : null;
      
      const payload = {
        orderId,
        shopOrderId,
        status: "delivered",
        assignmentId: null,
        assignedDeliveryBoy: null,
        userId: userIdStr,
        ownerId,
        message: "Order delivered"
      };

      io.to(`order:${orderId}`).emit("order:status", payload);

      if (userIdStr) {
        io.to(`user:${userIdStr}`).emit("order:status", payload);
        io.to(`user:${userIdStr}`).emit("orders:refresh", { scope: "user", orderId, userId: userIdStr });
        io.emit("orders:refresh", { scope: "user", orderId, userId: userIdStr });
      }

      if (ownerId) {
        io.to(`owner:${ownerId}`).emit("order:status", payload);
        io.to(`owner:${ownerId}`).emit("orders:refresh", { scope: "owner", orderId, ownerId });
        io.emit("orders:refresh", { scope: "owner", orderId, ownerId });
      }

      if (deliveryBoyIdStr) {
        io.to(`delivery:${deliveryBoyIdStr}`).emit("order:status", payload);
        io.to(`delivery:${deliveryBoyIdStr}`).emit("orders:refresh", { scope: "delivery", orderId });
      }
    }

    return res.status(200).json({ success: true, message: "Order marked as delivered successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};

export const rateOrder = async (req, res) => {
  try {
    const { orderId } = req.params;
    const { rating } = req.body;

    const parsedRating = Number(rating);
    if (!Number.isFinite(parsedRating) || parsedRating < 1 || parsedRating > 5) {
      return res
        .status(400)
        .json({ success: false, message: "Rating must be a number between 1 and 5" });
    }

    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }

    if (order.userId?.toString() !== req.userId?.toString()) {
      return res.status(403).json({ success: false, message: "You cannot rate this order" });
    }

    if (!Array.isArray(order.shopOrder) || order.shopOrder.length === 0) {
      return res.status(400).json({ success: false, message: "Order has no items to rate" });
    }

    const rateableItems = [];
    order.shopOrder.forEach((shopOrderDoc) => {
      if (shopOrderDoc.status !== "delivered") {
        return;
      }
      if (!Array.isArray(shopOrderDoc.shopOrderItems)) {
        return;
      }
      shopOrderDoc.shopOrderItems.forEach((orderItemDoc) => {
        const itemId = orderItemDoc.item?.toString?.();
        const alreadyRated = orderItemDoc.userRating !== null && orderItemDoc.userRating !== undefined;
        if (!itemId || alreadyRated) {
          return;
        }
        rateableItems.push({ orderItemDoc, itemId });
      });
    });

    if (rateableItems.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Order is either not delivered yet or already rated",
      });
    }

    const now = new Date();
    const ratingResults = [];

    for (const { orderItemDoc, itemId } of rateableItems) {
      try {
        // Update item rating via shop service
        await axios.post(`${SHOP_SERVICE_URL}/api/items/${itemId}/rating`, {
          rating: parsedRating
        });

        orderItemDoc.userRating = parsedRating;
        orderItemDoc.ratedAt = now;

        ratingResults.push({ itemId, rating: parsedRating });
      } catch (error) {
        console.error(`Error updating rating for item ${itemId}:`, error.message);
      }
    }

    await order.save();

    const io = getIO();
    if (io) {
      const orderIdStr = order._id.toString();
      const userIdStr = order.userId?.toString?.();
      if (userIdStr) {
        const payload = { scope: "user", orderId: orderIdStr, userId: userIdStr };
        io.to(`user:${userIdStr}`).emit("orders:refresh", payload);
        io.emit("orders:refresh", payload);
      }

      order.shopOrder.forEach((shopOrderDoc) => {
        const ownerIdStr = shopOrderDoc.owner?.toString?.();
        if (ownerIdStr) {
          const payload = { scope: "owner", orderId: orderIdStr, ownerId: ownerIdStr };
          io.to(`owner:${ownerIdStr}`).emit("orders:refresh", payload);
        }
      });
    }

    return res.status(200).json({
      success: true,
      message: "Thanks for rating your order",
      rating: parsedRating,
      ratedItems: ratingResults,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};
