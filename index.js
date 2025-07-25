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
  // console.log("🚀 ~ verifyFirebaseToken ~ authHeader:", authHeader);

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
    const blogCollection = db.collection("blogs");

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

    const verifyAdminOrVolunteer = async (req, res, next) => {
      try {
        const userEmail = req.firebaseUser?.email;

        if (!userEmail) {
          return res
            .status(401)
            .send({ msg: "Unauthorized: No user email found" });
        }

        const user = await userCollection.findOne({ email: userEmail });

        if (!user || (user.role !== "admin" && user.role !== "volunteer")) {
          return res.status(403).send({ msg: "Forbidden: Access denied" });
        }

        next();
      } catch (error) {
        console.error("Error in verifyAdminOrVolunteer middleware:", error);
        res.status(500).send({ msg: "Internal server error" });
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

    app.get(
      "/donation-requests/recent",
      verifyFirebaseToken,
      async (req, res) => {
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
      }
    );

    app.get(
      "/donation-requests/my-requests",
      verifyFirebaseToken,
      async (req, res) => {
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

          const totalCount = await donationRequestCollection.countDocuments(
            query
          );
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
      }
    );

    app.get("/users", verifyFirebaseToken, verifyAdmin, async (req, res) => {
      try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;

        const users = await userCollection
          .find({}, { projection: { password: 0 } })
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .toArray();

        const totalUsers = await userCollection.countDocuments();
        const totalPages = Math.ceil(totalUsers / limit);

        res.json({ users, totalPages });
      } catch (error) {
        console.error("Error fetching users:", error);
        res.status(500).json({ message: "Server error" });
      }
    });

    app.get(
      "/donation-requests",
      verifyFirebaseToken,
      verifyAdminOrVolunteer,
      async (req, res) => {
        try {
          const { status } = req.query;
          const page = parseInt(req.query.page) || 1;
          const limit = parseInt(req.query.limit) || 10;

          const query = {};
          if (status) query.status = status;

          const totalCount = await donationRequestCollection.countDocuments(
            query
          );
          const totalPages = Math.ceil(totalCount / limit);

          const requests = await donationRequestCollection
            .find(query)
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .toArray();

          res.json({ requests, totalPages });
        } catch (error) {
          console.error("Error fetching all donation requests:", error);
          res.status(500).json({ message: "Server error" });
        }
      }
    );

    app.get("/donation-requests/public", async (req, res) => {
      try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;

        const query = { status: "pending" };

        const totalCount = await donationRequestCollection.countDocuments(
          query
        );
        const totalPages = Math.ceil(totalCount / limit);

        const requests = await donationRequestCollection
          .find(query)
          .sort({ createdAt: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .toArray();

        res.json({ requests, totalPages });
      } catch (error) {
        console.error("Error fetching public donation requests:", error);
        res.status(500).json({ message: "Server error" });
      }
    });

    app.patch(
      "/users/:id/status",
      verifyFirebaseToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const { id } = req.params;
          const { status } = req.body;

          if (!ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid user ID" });
          }

          if (!status || !["active", "blocked"].includes(status)) {
            return res.status(400).json({ message: "Invalid status value" });
          }

          const result = await userCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { status, updatedAt: new Date() } }
          );

          if (result.matchedCount === 0) {
            return res.status(404).json({ message: "User not found" });
          }

          res.json({ message: "User status updated successfully" });
        } catch (error) {
          console.error("Error updating user status:", error);
          res.status(500).json({ message: "Server error" });
        }
      }
    );

    app.patch(
      "/users/:id/role",
      verifyFirebaseToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const { id } = req.params;
          const { role } = req.body;

          if (!ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid user ID" });
          }

          if (!role || !["donor", "volunteer", "admin"].includes(role)) {
            return res.status(400).json({ message: "Invalid role value" });
          }

          const result = await userCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { role, updatedAt: new Date() } }
          );

          if (result.matchedCount === 0) {
            return res.status(404).json({ message: "User not found" });
          }

          res.json({ message: "User role updated successfully" });
        } catch (error) {
          console.error("Error updating user role:", error);
          res.status(500).json({ message: "Server error" });
        }
      }
    );

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

    app.get("/donation-requests/:id", verifyFirebaseToken, async (req, res) => {
      try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ message: "Invalid request ID" });
        }

        const request = await donationRequestCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!request)
          return res.status(404).json({ message: "Request not found" });

        res.json(request);
      } catch (error) {
        console.error("Error fetching donation request:", error);
        res.status(500).json({ message: "Server error" });
      }
    });

    app.put("/donation-requests/:id", verifyFirebaseToken, async (req, res) => {
      try {
        const { id } = req.params;

        if (!ObjectId.isValid(id)) {
          return res.status(400).json({ message: "Invalid request ID" });
        }

        const request = await donationRequestCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!request) {
          return res.status(404).json({ message: "Request not found" });
        }

        const currentUser = await userCollection.findOne({
          email: req.firebaseUser.email,
        });

        if (!currentUser) {
          return res.status(401).json({ message: "User not found" });
        }

        const isOwner = request.requesterEmail === req.firebaseUser.email;
        const isAdmin = currentUser.role === "admin";

        if (!isOwner && !isAdmin) {
          return res
            .status(403)
            .json({ message: "Unauthorized to update this request" });
        }

        const updateData = { ...req.body };
        delete updateData._id;
        delete updateData.status;

        await donationRequestCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { ...updateData, updatedAt: new Date() } }
        );

        res.json({ message: "Donation request updated successfully" });
      } catch (error) {
        console.error("Error updating donation request:", error);
        res.status(500).json({ message: error.message });
      }
    });

    app.patch(
      "/donation-requests/:id/status",
      verifyFirebaseToken,
      async (req, res) => {
        const { id } = req.params;
        const { status } = req.body;

        const validStatuses = ["pending", "inprogress", "done", "canceled"];
        if (!ObjectId.isValid(id) || !validStatuses.includes(status)) {
          return res.status(400).json({ message: "Invalid ID or status" });
        }

        const [request, user] = await Promise.all([
          donationRequestCollection.findOne({ _id: new ObjectId(id) }),
          userCollection.findOne({ email: req.firebaseUser.email }),
        ]);

        if (!request || !user) {
          return res.status(404).json({ message: "Request or user not found" });
        }

        const allowed =
          user.role === "admin" ||
          user.role === "volunteer" ||
          request.requesterEmail === user.email;

        if (!allowed) {
          return res.status(403).json({ message: "Unauthorized" });
        }

        await donationRequestCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status, updatedAt: new Date() } }
        );

        res.json({ message: "Status updated successfully" });
      }
    );

    app.get("/donors/search", async (req, res) => {
      try {
        const { bloodGroup, district, upazila } = req.query;

        const validBloodGroups = [
          "A+",
          "A-",
          "B+",
          "B-",
          "AB+",
          "AB-",
          "O+",
          "O-",
        ];
        if (bloodGroup && !validBloodGroups.includes(bloodGroup)) {
          return res.status(400).json({ message: "Invalid blood group" });
        }

        const query = { role: "donor", status: "active" };

        if (bloodGroup) query.bloodGroup = bloodGroup;
        if (district) query.district = district;
        if (upazila) query.upazila = upazila;

        const donors = await userCollection.find(query).toArray();

        res.json(donors);
      } catch (error) {
        console.error("Error searching donors:", error);
        res.status(500).json({ message: "Server error" });
      }
    });

    app.patch(
      "/donation-requests/:id/donate",
      verifyFirebaseToken,
      async (req, res) => {
        try {
          const { id } = req.params;
          const { donorName, donorEmail } = req.body;

          if (!ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid request ID" });
          }

          if (!donorName || !donorEmail) {
            return res
              .status(400)
              .json({ message: "Donor name and email are required" });
          }

          const [request, user] = await Promise.all([
            donationRequestCollection.findOne({ _id: new ObjectId(id) }),
            userCollection.findOne({ email: req.firebaseUser.email }),
          ]);

          if (!request || !user) {
            return res
              .status(404)
              .json({ message: "Request or user not found" });
          }

          // Only allow if request is still pending
          if (request.status !== "pending") {
            return res.status(400).json({
              message: "This request is no longer available for donation",
            });
          }

          // Prevent donating to own request
          if (request.requesterEmail === user.email) {
            return res
              .status(403)
              .json({ message: "You cannot donate to your own request" });
          }

          await donationRequestCollection.updateOne(
            { _id: new ObjectId(id) },
            {
              $set: {
                donorName,
                donorEmail,
                status: "inprogress",
                updatedAt: new Date(),
              },
            }
          );

          res.json({ message: "Donation confirmed successfully" });
        } catch (error) {
          console.error("Error confirming donation:", error);
          res.status(500).json({ message: "Server error" });
        }
      }
    );

    app.get(
      "/admin/stats",
      verifyFirebaseToken,
      verifyAdminOrVolunteer,
      async (req, res) => {
        try {
          const totalDonors = await userCollection.countDocuments({
            role: "donor",
          });

          const totalRequests =
            await donationRequestCollection.estimatedDocumentCount();

          const donationsCollection = client
            .db("scarletDB")
            .collection("donations");
          const totalFundsResult = await donationsCollection
            .aggregate([
              {
                $group: {
                  _id: null,
                  total: { $sum: "$amount" },
                },
              },
            ])
            .toArray();

          const totalFunds = totalFundsResult[0]?.total || 0;

          res.send({ totalDonors, totalFunds, totalRequests });
        } catch (error) {
          console.error("Error fetching admin stats:", error);
          res.status(500).send({ message: "Internal server error" });
        }
      }
    );

    app.delete(
      "/donation-requests/:id",
      verifyFirebaseToken,
      async (req, res) => {
        try {
          const { id } = req.params;

          if (!ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid request ID" });
          }

          const request = await donationRequestCollection.findOne({
            _id: new ObjectId(id),
          });
          if (!request)
            return res.status(404).json({ message: "Request not found" });

          const userEmail = req.firebaseUser.email;
          const user = await userCollection.findOne({ email: userEmail });

          if (user.role !== "admin" && request.requesterEmail !== userEmail) {
            return res
              .status(403)
              .json({ message: "Unauthorized to delete this request" });
          }

          await donationRequestCollection.deleteOne({ _id: new ObjectId(id) });

          res.json({ message: "Donation request deleted successfully" });
        } catch (error) {
          console.error("Error deleting request:", error);
          res.status(500).json({ message: "Server error" });
        }
      }
    );

    app.post("/blogs", verifyFirebaseToken, async (req, res) => {
      try {
        const { title, thumbnail, content } = req.body;

        if (!title || !thumbnail || !content) {
          return res.status(400).json({ message: "All fields are required" });
        }

        const user = await userCollection.findOne({
          email: req.firebaseUser.email,
        });
        if (!user) return res.status(404).json({ message: "User not found" });

        const newBlog = {
          title,
          thumbnail,
          content,
          author: {
            name: user.name,
            email: user.email,
            role: user.role,
          },
          status: "draft",
          createdAt: new Date(),
          updatedAt: new Date(),
        };

        const result = await blogCollection.insertOne(newBlog);
        res.status(201).json({
          message: "Blog created successfully",
          id: result.insertedId,
        });
      } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
      }
    });

    app.get("/blogs", verifyFirebaseToken, async (req, res) => {
      try {
        const { status } = req.query;
        const filter = {};
        if (status) filter.status = status;

        const blogs = await blogCollection
          .find(filter)
          .sort({ createdAt: -1 })
          .toArray();
        res.json(blogs);
      } catch (error) {
        res.status(500).json({ message: "Server error", error: error.message });
      }
    });

    app.patch(
      "/blogs/:id/status",
      verifyFirebaseToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const { id } = req.params;
          const { status } = req.body;

          if (!ObjectId.isValid(id))
            return res.status(400).json({ message: "Invalid blog ID" });
          if (!["draft", "published"].includes(status))
            return res.status(400).json({ message: "Invalid status" });

          const blog = await blogCollection.findOne({ _id: new ObjectId(id) });
          if (!blog) return res.status(404).json({ message: "Blog not found" });

          await blogCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { status, updatedAt: new Date() } }
          );

          res.json({
            message: `Blog ${
              status === "published" ? "published" : "unpublished"
            } successfully`,
          });
        } catch (error) {
          res
            .status(500)
            .json({ message: "Server error", error: error.message });
        }
      }
    );

    app.delete(
      "/blogs/:id",
      verifyFirebaseToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const { id } = req.params;

          if (!ObjectId.isValid(id))
            return res.status(400).json({ message: "Invalid blog ID" });

          const blog = await blogCollection.findOne({ _id: new ObjectId(id) });
          if (!blog) return res.status(404).json({ message: "Blog not found" });

          await blogCollection.deleteOne({ _id: new ObjectId(id) });

          res.json({ message: "Blog deleted successfully" });
        } catch (error) {
          res
            .status(500)
            .json({ message: "Server error", error: error.message });
        }
      }
    );

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
