import mongoose from "mongoose";

const deliveryAssignmentSchema = new mongoose.Schema(
    {
        order: { type: mongoose.Schema.Types.ObjectId, ref: "Order",},
        shop: { type: mongoose.Schema.Types.ObjectId, ref: "Shop",},
        shopOrderId: { type: mongoose.Schema.Types.ObjectId, required: true },
        broadcastedTo:[{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
        assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        status:{
            type:String,
            enum:["broadcasted","assigned","picked-up","en-route","delivered","completed","cancelled"],
            default:"broadcasted"
        },
        acceptedAt: { type: Date, default: null },
        pickedUpAt: { type: Date, default: null },
        deliveredAt: { type: Date, default: null },
        completedAt: { type: Date, default: null },
        cancelReason: { type: String, default: null },

    },{ timestamps: true }
)

const DeliveryAssignment = mongoose.model("DeliveryAssignment", deliveryAssignmentSchema);
export default DeliveryAssignment;
