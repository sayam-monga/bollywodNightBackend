const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const Razorpay = require("razorpay");
const dotenv = require("dotenv");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs"); // Added missing bcrypt import

// Load environment variables
dotenv.config();

// Initialize Express
const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET;

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Initialize Razorpay
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Connect to MongoDB
mongoose
  .connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error("MongoDB connection error:", err));

// Define User Schema & Model (Fixed missing User model)
const userSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true },
  phone: String,
  password: String,
});
const User = mongoose.model("User", userSchema);

// Define Ticket Schema
const ticketSchema = new mongoose.Schema({
  type: { type: String, required: true, enum: ["STAG", "COUPLE"] },
  quantity: { type: Number, required: true },
  price: { type: Number, required: true },
});

// Define Booking Schema
const bookingSchema = new mongoose.Schema({
  tickets: [ticketSchema],
  totalAmount: { type: Number, required: true },
  name: { type: String, required: true },
  email: { type: String, required: true },
  phone: { type: String, required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: "User" },
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

// Test Route
app.get("/test", (req, res) => {
  res.send("Hello World!");
});

// Create order endpoint
app.post("/api/create-order", async (req, res) => {
  try {
    const { amount } = req.body;

    const options = {
      amount: amount * 100, // Convert to paise
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

// Register user
app.post("/register", async (req, res) => {
  const { name, email, phone, password } = req.body;

  try {
    let user = await User.findOne({ email });
    if (user) return res.status(400).json({ message: "User already exists" });

    const hashedPassword = await bcrypt.hash(password, 10);
    user = new User({ name, email, phone, password: hashedPassword });

    await user.save();

    const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: "1h" });

    res.status(201).json({ token, user });
  } catch (error) {
    console.error("Error in registration:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// Login user
app.post("/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ message: "Invalid credentials" });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch)
      return res.status(400).json({ message: "Invalid credentials" });

    const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: "1h" });

    res.json({ token, user });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// Authentication Middleware
const auth = (req, res, next) => {
  try {
    const authHeader = req.header("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res
        .status(401)
        .json({ message: "No token, authorization denied" });
    }

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = { id: decoded.id }; // Fix: Use `decoded.id` instead of `decoded.userId`
    next();
  } catch (error) {
    console.error("Auth middleware error:", error);
    res.status(401).json({ message: "Invalid token" });
  }
};

// Verify payment and save booking
app.post("/api/verify-payment", async (req, res) => {
  try {
    const {
      razorpay_payment_id,
      razorpay_order_id,
      razorpay_signature,
      formData,
    } = req.body;

    // Verify signature
    const generated_signature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + "|" + razorpay_payment_id)
      .digest("hex");

    if (generated_signature !== razorpay_signature) {
      return res.status(400).json({ message: "Invalid payment signature" });
    }

    // Generate a unique booking ID
    const bookingId = "BN" + Math.floor(Math.random() * 10000);

    // Save booking
    const newBooking = new Booking({
      tickets: formData.tickets,
      totalAmount: formData.totalAmount,
      name: formData.name,
      email: formData.email,
      phone: formData.phone,
      userId: formData.userId,
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

// Get all bookings for a user
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

// Get all bookings (for testing)
app.get("/api/bookings", async (req, res) => {
  try {
    const bookings = await Booking.find();
    res.json(bookings);
  } catch (error) {
    console.error("Error fetching bookings:", error);
    res.status(500).json({ message: "Error fetching bookings" });
  }
});

// Get passes for the authenticated user
app.get("/api/bookings/my-passes", auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const bookings = await Booking.find({ userId });

    const passes = bookings.flatMap((booking) =>
      booking.tickets.map((ticket) => ({
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
      }))
    );

    res.json(passes);
  } catch (error) {
    console.error("Error fetching passes:", error);
    res.status(500).json({ message: "Error fetching passes" });
  }
});

// Start server
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
