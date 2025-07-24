const express = require("express");
const cors = require("cors");

const {
  MongoClient,
  ServerApiVersion,
  ObjectId,
  ChangeStream,
} = require("mongodb");
const dotenv = require("dotenv");
dotenv.config();

var admin = require("firebase-admin");
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf-8"
);

const serviceAccount = JSON.parse(decoded);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB Connection

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.snqhtaz.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

const verifyFirebaseToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  console.log("🚀 ~ verifyFirebaseToken ~ authHeader:", authHeader);

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Unauthorized: No token provided" });
  }

  const idToken = authHeader.split(" ")[1];

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.firebaseUser = decodedToken; // You can access user info like uid, email, etc.
    next();
  } catch (error) {
    return res
      .status(401)
      .json({ message: "Unauthorized: Invalid token from catch" });
  }
};

async function run() {
  try {
    await client.connect();
    const db = client.db("scarletDB");
    const userCollection = db.collection("users");
    const donationRequestCollection = db.collection("donationRequests");

    const verifyAdmin = async (req, res, next) => {
      const user = await userCollection.findOne({
        email: req.firebaseUser.email,
      });

      if (user.role === "admin") {
        next();
      } else {
        res.status(403).send({ msg: "unauthorized" });
      }
    };

    app.post("/users", async (req, res) => {
      const {
        name,
        email,
        avatar,
        bloodGroup,
        district,
        upazila,
        role = "donor",
        status = "active",
      } = req.body;

      if (!name || !email || !avatar || !bloodGroup || !district || !upazila) {
        return res.status(400).json({ message: "Missing required fields" });
      }

      const existingUser = await userCollection.findOne({ email });
      if (existingUser) {
        return res.status(409).json({ message: "User already exists" });
      }

      const newUser = {
        name,
        email,
        avatar,
        bloodGroup,
        district,
        upazila,
        role,
        status,
        createdAt: new Date(),
      };

      const result = await userCollection.insertOne(newUser);
      res.status(201).json({
        message: "User registered successfully",
        userId: result.insertedId,
      });
    });

    app.post("/donation-requests", verifyFirebaseToken, async (req, res) => {
      const email = req.firebaseUser.email;
      const user = await userCollection.findOne({ email });

      if (!user) return res.status(404).send({ message: "User not found" });
      if (user.status !== "active")
        return res
          .status(403)
          .send({ message: "Blocked users cannot create requests" });

      const data = req.body;
      if (
        !data.recipientName ||
        !data.recipientDistrict ||
        !data.recipientUpazila ||
        !data.hospitalName ||
        !data.fullAddress ||
        !data.bloodGroup ||
        !data.donationDate ||
        !data.donationTime ||
        !data.requestMessage
      ) {
        return res.status(400).send({ message: "Missing fields" });
      }

      const newRequest = {
        ...data,
        requesterName: user.name,
        requesterEmail: user.email,
        status: "pending",
        createdAt: new Date(),
      };

      const result = await donationRequestCollection.insertOne(newRequest);
      res.send({ message: "Request created", id: result.insertedId });
    });

    app.get("/donation-requests/recent", verifyFirebaseToken, async (req, res) => {
  try {
    const email = req.query.email;
    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    const requests = await donationRequestCollection
      .find({ requesterEmail: email })
      .sort({ createdAt: -1 })
      .limit(3)
      .toArray();

    res.json(requests);
  } catch (error) {
    console.error("Error fetching recent donation requests:", error);
    res.status(500).json({ message: "Server error" });
  }
});

    app.get("/donation-requests/my-requests", verifyFirebaseToken, async (req, res) => {
  try {
    const email = req.query.email;
    const status = req.query.status; 
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 5;

    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }

    const query = { requesterEmail: email };
    if (status) query.status = status;

    const totalCount = await donationRequestCollection.countDocuments(query);
    const totalPages = Math.ceil(totalCount / limit);

    const requests = await donationRequestCollection
      .find(query)
      .sort({ createdAt: -1 }) 
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray();

    res.json({ requests, totalPages });
  } catch (error) {
    console.error("Error fetching donation requests:", error);
    res.status(500).json({ message: "Server error" });
  }
});

    app.get("/users/profile", verifyFirebaseToken, async (req, res) => {
      try {
        const email = req.firebaseUser.email;
        const user = await userCollection.findOne(
          { email },
          { projection: { _id: 0 } }
        );

        if (!user) {
          return res.status(404).json({ message: "User not found" });
        }

        res.json(user);
      } catch (error) {
        res.status(500).json({ message: "Server error" });
      }
    });

    app.get("/users/:email/role", verifyFirebaseToken, async (req, res) => {
      const email = req.params.email;
      const user = await userCollection.findOne({ email });
      if (user) {
        return res.send({ role: user.role });
      }
      res.status(404).send({ message: "User not found" });
    });

    app.put("/users/profile", verifyFirebaseToken, async (req, res) => {
      try {
        const email = req.firebaseUser.email;
        const { name, avatar, district, upazila, bloodGroup } = req.body;

        if (!name || !district || !upazila || !bloodGroup) {
          return res.status(400).json({ message: "Missing required fields" });
        }

        const updateDoc = {
          $set: {
            name,
            avatar,
            district,
            upazila,
            bloodGroup,
            updatedAt: new Date(),
          },
        };

        const result = await userCollection.updateOne({ email }, updateDoc);

        if (result.matchedCount === 0) {
          return res.status(404).json({ message: "User not found" });
        }

        const updatedUser = await userCollection.findOne(
          { email },
          { projection: { _id: 0, password: 0 } }
        );

        res.json(updatedUser);
      } catch (error) {
        console.error("Error updating profile:", error);
        res.status(500).json({ message: "Server error" });
      }
    });

    console.log("Connected");
  } finally {
  }
}

run().catch(console.dir);

// Root route
app.get("/", async (req, res) => {
  res.send({ msg: "hello" });
});

app.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});
