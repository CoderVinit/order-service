import { Server } from "socket.io";

let io;

export const initializeSocket = (server) => {
  io = new Server(server, {
    cors: {
      origin: process.env.CLIENT_URL || "http://localhost:5173",
      credentials: true,
    },
  });

  io.on("connection", (socket) => {
    console.log("Client connected:", socket.id);

    // Join user-specific room
    socket.on("join:user", (userId) => {
      socket.join(`user:${userId}`);
      console.log(`User ${userId} joined room user:${userId}`);
    });

    // Join owner-specific room
    socket.on("join:owner", (ownerId) => {
      socket.join(`owner:${ownerId}`);
      console.log(`Owner ${ownerId} joined room owner:${ownerId}`);
    });

    // Join delivery boy-specific room
    socket.on("join:delivery", (deliveryBoyId) => {
      socket.join(`delivery:${deliveryBoyId}`);
      console.log(`Delivery boy ${deliveryBoyId} joined room delivery:${deliveryBoyId}`);
    });

    // Join order-specific room
    socket.on("join:order", (orderId) => {
      socket.join(`order:${orderId}`);
      console.log(`Socket ${socket.id} joined room order:${orderId}`);
    });

    socket.on("disconnect", () => {
      console.log("Client disconnected:", socket.id);
    });
  });

  console.log("Socket.IO initialized");
  return io;
};

export const getIO = () => {
  if (!io) {
    throw new Error("Socket.io not initialized!");
  }
  return io;
};
