import express from 'express';
import { verifyToken, checkRole } from '../middleware/auth.middleware.js';
import { 
  placeOrder, 
  getMyOrders, 
  getOwnerOrders, 
  updateOrderStatus,
  getAssignmentsOfDeliveryBoy,
  acceptOrder,
  currentOrder,
  getOrderById,
  markOrderAsDelivered,
  orderDelivered,
  rateOrder
} from '../controllers/order.controller.js';

const router = express.Router();

router.post("/place-order", verifyToken, checkRole("user"), placeOrder);
router.get("/my-orders", verifyToken, checkRole("user"), getMyOrders);
router.get("/owner-orders", verifyToken, checkRole("owner"), getOwnerOrders);
router.put("/update-order-status/:orderId/:shopOrderId", verifyToken, checkRole("owner"), updateOrderStatus);
router.get("/get-assignment", verifyToken, checkRole("deliveryBoy"), getAssignmentsOfDeliveryBoy);
router.post("/accept-order/:assignmentId", verifyToken, checkRole("deliveryBoy"), acceptOrder);
router.get("/current-order", verifyToken, checkRole("deliveryBoy"), currentOrder);
router.get("/get-order-by-id/:orderId", verifyToken, getOrderById);
router.post("/mark-order-as-delivered", verifyToken, checkRole("deliveryBoy"), markOrderAsDelivered);
router.post("/send-delivery-otp", verifyToken, checkRole("deliveryBoy"), orderDelivered);
router.post("/rate-order/:orderId", verifyToken, checkRole("user"), rateOrder);

export default router;
