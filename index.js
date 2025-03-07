const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const Razorpay = require("razorpay");
const dotenv = require("dotenv");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || "your_jwt_secret";

app.use(cors());
app.use(bodyParser.json());

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error("MongoDB connection error:", err));

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  phone: { type: String, required: true },
  password: { type: String, required: true },
});
const User = mongoose.model("User", userSchema);

const ticketSchema = new mongoose.Schema({
  type: { type: String, required: true, enum: ["STAG", "COUPLE"] },
  quantity: { type: Number, required: true },
  price: { type: Number, required: true },
});

const bookingSchema = new mongoose.Schema({
  tickets: [ticketSchema],
  totalAmount: { type: Number, required: true },
  name: { type: String, required: true },
  email: { type: String, required: true },
  phone: { type: String, required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  paymentId: { type: String, required: true },
  bookingId: { type: String, required: true },
  status: {
    type: String,
    required: true,
    enum: ["PENDING", "CONFIRMED", "USED"],
    default: "CONFIRMED",
  },
  createdAt: { type: Date, default: Date.now },
});
const Booking = mongoose.model("Booking", bookingSchema);

app.post("/api/create-order", async (req, res) => {
  try {
    const { amount } = req.body;
    const options = {
      amount: amount * 100,
      currency: "INR",
      receipt: "receipt_" + Date.now(),
      payment_capture: 1,
    };
    const order = await razorpay.orders.create(options);
    res.json({ id: order.id, amount: order.amount, currency: order.currency });
  } catch (error) {
    console.error("Error creating order:", error);
    res.status(500).json({ message: "Error creating order" });
  }
});

app.post("/api/verify-payment", async (req, res) => {
  try {
    const {
      razorpay_payment_id,
      razorpay_order_id,
      razorpay_signature,
      formData,
    } = req.body;

    console.log("Received formData:", formData);

    if (!formData || !formData.userId) {
      return res.status(400).json({ message: "User ID is required" });
    }

    const generated_signature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + "|" + razorpay_payment_id)
      .digest("hex");

    if (generated_signature !== razorpay_signature) {
      return res.status(400).json({ message: "Invalid payment signature" });
    }

    const bookingId = "BN" + Math.floor(Math.random() * 10000);

    const newBooking = new Booking({
      ...formData,
      paymentId: razorpay_payment_id,
      bookingId,
    });

    await newBooking.save();
    res.json({ success: true, booking: newBooking });
  } catch (error) {
    console.error("Error verifying payment:", error);
    res.status(500).json({ message: "Error verifying payment" });
  }
});

app.get("/api/bookings/user/:email", async (req, res) => {
  try {
    const { email } = req.params;
    const bookings = await Booking.find({ email });
    res.json(bookings);
  } catch (error) {
    console.error("Error fetching user bookings:", error);
    res.status(500).json({ message: "Error fetching bookings" });
  }
});

app.get("/api/bookings", async (req, res) => {
  try {
    const bookings = await Booking.find();
    res.json(bookings);
  } catch (error) {
    console.error("Error fetching bookings:", error);
    res.status(500).json({ message: "Error fetching bookings" });
  }
});

app.post("/api/register", async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;
    let user = await User.findOne({ email });
    if (user) return res.status(400).json({ message: "Email already in use" });

    const hashedPassword = await bcrypt.hash(password, 10);
    user = new User({ name, email, phone, password: hashedPassword });
    await user.save();

    const token = jwt.sign({ userId: user._id }, JWT_SECRET, {
      expiresIn: "7d",
    });

    res.json({ token, user: { userId: user._id, name, email, phone } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});
app.get("/api/bookings/my-passes", async (req, res) => {
  try {
    // Handle authentication directly in the route
    const authHeader = req.header("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res
        .status(401)
        .json({ message: "No token, authorization denied" });
    }

    // Extract token from header
    const token = authHeader.split(" ")[1];

    // Verify token
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ message: "Token is not valid" });
    }

    // Get userId from decoded token
    const userId = decoded.userId;

    console.log("Fetching passes for user:", userId);

    // Find all bookings for this user
    const bookings = await Booking.find({ userId });

    console.log(`Found ${bookings.length} bookings for user ${userId}`);

    // Transform bookings into passes format expected by the frontend
    const passes = bookings
      .map((booking) => {
        // For each ticket type in the booking, create a pass
        return booking.tickets.map((ticket) => ({
          _id: booking._id.toString(),
          bookingId: booking.bookingId,
          ticketType: ticket.type,
          quantity: ticket.quantity,
          totalAmount: ticket.price * ticket.quantity,
          name: booking.name,
          email: booking.email,
          phone: booking.phone,
          status: booking.status,
          createdAt: booking.createdAt,
        }));
      })
      .flat(); // Flatten the array of arrays

    console.log(`Transformed into ${passes.length} passes`);

    res.json(passes);
  } catch (error) {
    console.error("Error fetching passes:", error);
    res.status(500).json({ message: "Error fetching passes" });
  }
});
app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user)
      return res.status(400).json({ message: "Invalid email or password" });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch)
      return res.status(400).json({ message: "Invalid email or password" });

    const token = jwt.sign({ userId: user._id }, JWT_SECRET, {
      expiresIn: "7d",
    });

    res.json({
      token,
      user: { id: user._id, name: user.name, email, phone: user.phone },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
