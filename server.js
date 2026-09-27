const express = require("express");
const session = require("express-session");
const fs = require("fs");
const path = require("path");

const app = express();

// =====================================================
// RAILWAY / PROXY CONFIG
// =====================================================

app.set("trust proxy", 1);

const PORT = process.env.PORT || 3000;

const DB_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DB_DIR, "db.json");

// =====================================================
// ADMIN / SESSION SETTINGS
// =====================================================

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "change-me";
const SESSION_SECRET =
  process.env.SESSION_SECRET || "dev-secret-change-me";

// =====================================================
// DEFAULT DATABASE
// =====================================================

const DEFAULT_DB = {
  settings: {
    siteName: "Quick Exchange",

    rates: {
      easypaisa: 3.2,
      jazzcash: 3.18,
      usdt: 0.0115
    },

    feePercent: 0,

    minAmount: 100,
    maxAmount: 100000,

    methods: {
      easypaisa: true,
      jazzcash: true,
      usdt: true
    },

    contact: {
      whatsapp: "",
      telegram: ""
    }
  },

  upiLinks: [],

  orders: []
};

// =====================================================
// DATABASE HELPERS
// =====================================================

function ensureDatabase() {
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }

  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(
      DB_FILE,
      JSON.stringify(DEFAULT_DB, null, 2),
      "utf8"
    );
  }
}

function readDatabase() {
  ensureDatabase();

  try {
    const raw = fs.readFileSync(DB_FILE, "utf8");
    const parsed = JSON.parse(raw);

    return {
      settings: {
        ...DEFAULT_DB.settings,
        ...(parsed.settings || {}),
        rates: {
          ...DEFAULT_DB.settings.rates,
          ...(parsed.settings?.rates || {})
        },
        methods: {
          ...DEFAULT_DB.settings.methods,
          ...(parsed.settings?.methods || {})
        },
        contact: {
          ...DEFAULT_DB.settings.contact,
          ...(parsed.settings?.contact || {})
        }
      },

      upiLinks: Array.isArray(parsed.upiLinks)
        ? parsed.upiLinks
        : [],

      orders: Array.isArray(parsed.orders)
        ? parsed.orders
        : []
    };
  } catch (error) {
    console.error("Database read error:", error.message);
    throw new Error("Database file is invalid.");
  }
}

function writeDatabase(db) {
  ensureDatabase();

  const tempFile = DB_FILE + ".tmp";

  fs.writeFileSync(
    tempFile,
    JSON.stringify(db, null, 2),
    "utf8"
  );

  fs.renameSync(tempFile, DB_FILE);
}

// =====================================================
// BASIC HELPERS
// =====================================================

function generateId(prefix = "") {
  return (
    prefix +
    Date.now().toString(36) +
    Math.random().toString(36).substring(2, 8)
  ).toUpperCase();
}

function cleanString(value, maxLength = 500) {
  if (value === undefined || value === null) {
    return "";
  }

  return String(value).trim().slice(0, maxLength);
}

function numberValue(value) {
  const n = Number(value);

  if (!Number.isFinite(n)) {
    return null;
  }

  return n;
}

function validDate(value) {
  if (!value) return null;

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date;
}

// =====================================================
// UPI STATUS
// =====================================================

function getUpiState(upi) {
  if (!upi) {
    return "disabled";
  }

  if (upi.archived) {
    return "archived";
  }

  if (upi.enabled === false) {
    return "disabled";
  }

  const now = Date.now();

  const start = upi.startAt
    ? new Date(upi.startAt).getTime()
    : null;

  const expiry = upi.expiryAt
    ? new Date(upi.expiryAt).getTime()
    : null;

  if (start && Number.isFinite(start) && now < start) {
    return "scheduled";
  }

  if (expiry && Number.isFinite(expiry) && now >= expiry) {
    return "expired";
  }

  return "active";
}

function publicUpi(upi) {
  return {
    id: upi.id,
    name: upi.name,
    label: upi.label,
    url: upi.url,
    startAt: upi.startAt || null,
    expiryAt: upi.expiryAt || null,
    state: getUpiState(upi)
  };
}

// =====================================================
// EXPRESS MIDDLEWARE
// =====================================================

app.use(express.json({ limit: "1mb" }));

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    proxy: true,

    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 8 * 60 * 60 * 1000
    }
  })
);

// =====================================================
// ADMIN AUTH MIDDLEWARE
// =====================================================

function adminOnly(req, res, next) {
  if (req.session && req.session.admin === true) {
    return next();
  }

  return res.status(401).json({
    success: false,
    message: "Unauthorized. Please login again."
  });
}

// =====================================================
// PUBLIC API
// =====================================================

app.get("/api/public", (req, res) => {
  try {
    const db = readDatabase();

    const activeUpi = db.upiLinks
      .filter((upi) => getUpiState(upi) === "active")
      .map(publicUpi);

    res.json({
      success: true,

      settings: {
        siteName: db.settings.siteName,

        rates: db.settings.rates,

        feePercent: db.settings.feePercent,

        minAmount: db.settings.minAmount,

        maxAmount: db.settings.maxAmount,

        methods: db.settings.methods,

        contact: db.settings.contact
      },

      upiLinks: activeUpi
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Unable to load exchange information."
    });
  }
});

// =====================================================
// CREATE ORDER
// =====================================================

app.post("/api/orders", (req, res) => {
  try {
    const db = readDatabase();

    const amount = numberValue(req.body.amount);
    const receiveMethod = cleanString(
      req.body.receiveMethod,
      50
    ).toLowerCase();

    const receiverName = cleanString(
      req.body.receiverName,
      150
    );

    const receiverNumber = cleanString(
      req.body.receiverNumber,
      150
    );

    const wallet = cleanString(
      req.body.wallet,
      300
    );

    const network = cleanString(
      req.body.network,
      50
    ).toUpperCase();

    // -----------------------------------------------
    // Amount validation
    // -----------------------------------------------

    if (amount === null || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid amount."
      });
    }

    if (amount < Number(db.settings.minAmount)) {
      return res.status(400).json({
        success: false,
        message:
          "Minimum amount is " +
          db.settings.minAmount
      });
    }

    if (amount > Number(db.settings.maxAmount)) {
      return res.status(400).json({
        success: false,
        message:
          "Maximum amount is " +
          db.settings.maxAmount
      });
    }

    // -----------------------------------------------
    // Method validation
    // -----------------------------------------------

    const allowedMethods = [
      "easypaisa",
      "jazzcash",
      "usdt"
    ];

    if (!allowedMethods.includes(receiveMethod)) {
      return res.status(400).json({
        success: false,
        message: "Invalid receiving method."
      });
    }

    if (!db.settings.methods[receiveMethod]) {
      return res.status(400).json({
        success: false,
        message: "This receiving method is currently disabled."
      });
    }

    // -----------------------------------------------
    // Receiver validation
    // -----------------------------------------------

    if (
      receiveMethod === "easypaisa" ||
      receiveMethod === "jazzcash"
    ) {
      if (!receiverName) {
        return res.status(400).json({
          success: false,
          message: "Receiver name is required."
        });
      }

      if (!receiverNumber) {
        return res.status(400).json({
          success: false,
          message: "Receiver number is required."
        });
      }
    }

    if (receiveMethod === "usdt") {
      if (!wallet) {
        return res.status(400).json({
          success: false,
          message: "USDT wallet address is required."
        });
      }

      if (
        !["TRC20", "BEP20", "ERC20"].includes(network)
      ) {
        return res.status(400).json({
          success: false,
          message: "Please select a valid USDT network."
        });
      }
    }

    // -----------------------------------------------
    // Lock current rate
    // -----------------------------------------------

    const rate = numberValue(
      db.settings.rates[receiveMethod]
    );

    if (rate === null || rate <= 0) {
      return res.status(500).json({
        success: false,
        message: "Exchange rate is not configured."
      });
    }

    const feePercent =
      numberValue(db.settings.feePercent) || 0;

    const grossReceive = amount * rate;

    const feeAmount =
      grossReceive * (feePercent / 100);

    const receiveAmount =
      grossReceive - feeAmount;

    // -----------------------------------------------
    // Create order
    // -----------------------------------------------

    let orderId;

    do {
      orderId = generateId("QE-");
    } while (
      db.orders.some((order) => order.id === orderId)
    );

    const order = {
      id: orderId,

      createdAt: new Date().toISOString(),

      updatedAt: new Date().toISOString(),

      status: "pending",

      amount: amount,

      receiveMethod: receiveMethod,

      rate: rate,

      feePercent: feePercent,

      feeAmount: Number(feeAmount.toFixed(8)),

      receiveAmount: Number(
        receiveAmount.toFixed(8)
      ),

      receiver: {
        name: receiverName,
        number: receiverNumber,
        wallet: wallet,
        network: network
      },

      selectedUpiId: null,

      paymentReference: "",

      adminNote: ""
    };

    db.orders.push(order);

    writeDatabase(db);

    return res.status(201).json({
      success: true,

      order: {
        id: order.id,
        createdAt: order.createdAt,
        status: order.status,
        amount: order.amount,
        receiveMethod: order.receiveMethod,
        rate: order.rate,
        feePercent: order.feePercent,
        feeAmount: order.feeAmount,
        receiveAmount: order.receiveAmount
      }
    });
  } catch (error) {
    console.error("Create order error:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to create order."
    });
  }
});

// =====================================================
// GET ORDER
// =====================================================

app.get("/api/orders/:id", (req, res) => {
  try {
    const db = readDatabase();

    const id = cleanString(req.params.id, 100);

    const order = db.orders.find(
      (item) => item.id === id
    );

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found."
      });
    }

    res.json({
      success: true,

      order: {
        id: order.id,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,

        status: order.status,

        amount: order.amount,

        receiveMethod: order.receiveMethod,

        rate: order.rate,

        feePercent: order.feePercent,

        feeAmount: order.feeAmount,

        receiveAmount: order.receiveAmount,

        paymentReference:
          order.paymentReference || "",

        receiver: {
          name: order.receiver?.name || "",
          number: order.receiver?.number || "",
          wallet: order.receiver?.wallet || "",
          network: order.receiver?.network || ""
        },

        selectedUpiId:
          order.selectedUpiId || null
      }
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Unable to load order."
    });
  }
});

// =====================================================
// UPDATE PAYMENT REFERENCE
// =====================================================

app.put("/api/orders/:id", (req, res) => {
  try {
    const db = readDatabase();

    const order = db.orders.find(
      (item) => item.id === req.params.id
    );

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found."
      });
    }

    if (
      req.body.paymentReference !== undefined
    ) {
      order.paymentReference = cleanString(
        req.body.paymentReference,
        200
      );
    }

    order.updatedAt = new Date().toISOString();

    writeDatabase(db);

    res.json({
      success: true,
      message: "Order updated successfully."
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Unable to update order."
    });
  }
});

// =====================================================
// SELECT UPI
// =====================================================

app.post("/api/orders/:id/select-upi", (req, res) => {
  try {
    const db = readDatabase();

    const order = db.orders.find(
      (item) => item.id === req.params.id
    );

    if (!order) {
      return res.status(404).json({
        success: false,
        message: "Order not found."
      });
    }

    const upiId = cleanString(
      req.body.upiId,
      100
    );

    if (!upiId) {
      return res.status(400).json({
        success: false,
        message: "UPI payment option is required."
      });
    }

    const upi = db.upiLinks.find(
      (item) => item.id === upiId
    );

    if (!upi) {
      return res.status(404).json({
        success: false,
        message: "UPI payment option not found."
      });
    }

    const state = getUpiState(upi);

    if (state !== "active") {
      return res.status(400).json({
        success: false,
        message:
          "This UPI payment option is no longer active."
      });
    }

    order.selectedUpiId = upi.id;
    order.updatedAt = new Date().toISOString();

    writeDatabase(db);

    res.json({
      success: true,
      url: upi.url
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Unable to select UPI."
    });
  }
});

// =====================================================
// ADMIN LOGIN
// =====================================================

app.post("/api/admin/login", (req, res) => {
  try {
    const username = cleanString(
      req.body.username,
      100
    );

    const password = String(
      req.body.password || ""
    );

    if (
      username !== ADMIN_USER ||
      password !== ADMIN_PASS
    ) {
      return res.status(401).json({
        success: false,
        message: "Invalid username or password."
      });
    }

    req.session.admin = true;
    req.session.username = ADMIN_USER;

    req.session.save((error) => {
      if (error) {
        console.error(
          "Session save error:",
          error
        );

        return res.status(500).json({
          success: false,
          message: "Unable to create admin session."
        });
      }

      return res.json({
        success: true,
        message: "Login successful."
      });
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Login failed."
    });
  }
});

// =====================================================
// ADMIN LOGOUT
// =====================================================

app.post("/api/admin/logout", (req, res) => {
  req.session.destroy((error) => {
    if (error) {
      console.error(error);

      return res.status(500).json({
        success: false,
        message: "Logout failed."
      });
    }

    res.clearCookie("connect.sid");

    res.json({
      success: true
    });
  });
});

// =====================================================
// ADMIN SESSION CHECK
// =====================================================

app.get("/api/admin/me", (req, res) => {
  if (
    req.session &&
    req.session.admin === true
  ) {
    return res.json({
      success: true,
      authenticated: true,
      username: req.session.username || ADMIN_USER
    });
  }

  return res.status(401).json({
    success: false,
    authenticated: false
  });
});

// =====================================================
// ADMIN DATA
// =====================================================

app.get(
  "/api/admin/data",
  adminOnly,
  (req, res) => {
    try {
      const db = readDatabase();

      const upiLinks = db.upiLinks.map(
        (upi) => ({
          ...upi,
          state: getUpiState(upi)
        })
      );

      res.json({
        success: true,

        settings: db.settings,

        upiLinks: upiLinks,

        orders: db.orders
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        success: false,
        message: "Unable to load admin data."
      });
    }
  }
);

// =====================================================
// UPDATE SETTINGS
// =====================================================

app.put(
  "/api/admin/settings",
  adminOnly,
  (req, res) => {
    try {
      const db = readDatabase();

      const body = req.body || {};

      if (body.siteName !== undefined) {
        db.settings.siteName = cleanString(
          body.siteName,
          100
        );
      }

      if (body.feePercent !== undefined) {
        const fee = numberValue(
          body.feePercent
        );

        if (
          fee === null ||
          fee < 0 ||
          fee > 100
        ) {
          return res.status(400).json({
            success: false,
            message: "Invalid fee percentage."
          });
        }

        db.settings.feePercent = fee;
      }

      if (body.minAmount !== undefined) {
        const min = numberValue(
          body.minAmount
        );

        if (min === null || min < 0) {
          return res.status(400).json({
            success: false,
            message: "Invalid minimum amount."
          });
        }

        db.settings.minAmount = min;
      }

      if (body.maxAmount !== undefined) {
        const max = numberValue(
          body.maxAmount
        );

        if (max === null || max <= 0) {
          return res.status(400).json({
            success: false,
            message: "Invalid maximum amount."
          });
        }

        db.settings.maxAmount = max;
      }

      if (body.rates) {
        for (const method of [
          "easypaisa",
          "jazzcash",
          "usdt"
        ]) {
          if (
            body.rates[method] !== undefined
          ) {
            const rate = numberValue(
              body.rates[method]
            );

            if (rate === null || rate <= 0) {
              return res.status(400).json({
                success: false,
                message:
                  "Invalid rate for " + method
              });
            }

            db.settings.rates[method] = rate;
          }
        }
      }

      if (body.methods) {
        for (const method of [
          "easypaisa",
          "jazzcash",
          "usdt"
        ]) {
          if (
            body.methods[method] !== undefined
          ) {
            db.settings.methods[method] =
              Boolean(body.methods[method]);
          }
        }
      }

      if (body.contact) {
        if (
          body.contact.whatsapp !== undefined
        ) {
          db.settings.contact.whatsapp =
            cleanString(
              body.contact.whatsapp,
              300
            );
        }

        if (
          body.contact.telegram !== undefined
        ) {
          db.settings.contact.telegram =
            cleanString(
              body.contact.telegram,
              300
            );
        }
      }

      if (
        db.settings.minAmount >
        db.settings.maxAmount
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Minimum amount cannot be greater than maximum amount."
        });
      }

      writeDatabase(db);

      res.json({
        success: true,
        message: "Settings saved successfully."
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        success: false,
        message: "Unable to save settings."
      });
    }
  }
);

// =====================================================
// ADD UPI
// =====================================================

app.post(
  "/api/admin/upi",
  adminOnly,
  (req, res) => {
    try {
      const db = readDatabase();

      const name = cleanString(
        req.body.name,
        100
      );

      const label = cleanString(
        req.body.label,
        150
      );

      const url = cleanString(
        req.body.url,
        1000
      );

      const startAt =
        req.body.startAt
          ? validDate(req.body.startAt)
          : null;

      const expiryAt =
        req.body.expiryAt
          ? validDate(req.body.expiryAt)
          : null;

      if (!name) {
        return res.status(400).json({
          success: false,
          message: "UPI name is required."
        });
      }

      if (!url) {
        return res.status(400).json({
          success: false,
          message: "UPI URL is required."
        });
      }

      try {
        const parsedUrl = new URL(url);

        if (
          parsedUrl.protocol !== "http:" &&
          parsedUrl.protocol !== "https:"
        ) {
          return res.status(400).json({
            success: false,
            message:
              "UPI URL must use HTTP or HTTPS."
          });
        }
      } catch {
        return res.status(400).json({
          success: false,
          message: "Invalid UPI URL."
        });
      }

      if (
        req.body.startAt &&
        !startAt
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid start date/time."
        });
      }

      if (
        req.body.expiryAt &&
        !expiryAt
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid expiry date/time."
        });
      }

      if (
        startAt &&
        expiryAt &&
        expiryAt.getTime() <=
          startAt.getTime()
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Expiry must be later than start."
        });
      }

      const upi = {
        id: generateId("UPI-"),

        name: name,

        label: label,

        url: url,

        startAt: startAt
          ? startAt.toISOString()
          : null,

        expiryAt: expiryAt
          ? expiryAt.toISOString()
          : null,

        enabled: true,

        archived: false,

        createdAt:
          new Date().toISOString(),

        updatedAt:
          new Date().toISOString()
      };

      db.upiLinks.push(upi);

      writeDatabase(db);

      res.status(201).json({
        success: true,
        message: "UPI added successfully.",
        upi: {
          ...upi,
          state: getUpiState(upi)
        }
      });
    } catch (error) {
      console.error(
        "Add UPI error:",
        error
      );

      res.status(500).json({
        success: false,
        message: "Unable to add UPI."
      });
    }
  }
);

// =====================================================
// EDIT UPI
// =====================================================

app.put(
  "/api/admin/upi/:id",
  adminOnly,
  (req, res) => {
    try {
      const db = readDatabase();

      const upi = db.upiLinks.find(
        (item) => item.id === req.params.id
      );

      if (!upi) {
        return res.status(404).json({
          success: false,
          message: "UPI not found."
        });
      }

      if (req.body.name !== undefined) {
        upi.name = cleanString(
          req.body.name,
          100
        );
      }

      if (req.body.label !== undefined) {
        upi.label = cleanString(
          req.body.label,
          150
        );
      }

      if (req.body.url !== undefined) {
        const url = cleanString(
          req.body.url,
          1000
        );

        try {
          const parsedUrl = new URL(url);

          if (
            parsedUrl.protocol !== "http:" &&
            parsedUrl.protocol !== "https:"
          ) {
            throw new Error();
          }
        } catch {
          return res.status(400).json({
            success: false,
            message: "Invalid UPI URL."
          });
        }

        upi.url = url;
      }

      if (
        req.body.startAt !== undefined
      ) {
        if (!req.body.startAt) {
          upi.startAt = null;
        } else {
          const date = validDate(
            req.body.startAt
          );

          if (!date) {
            return res.status(400).json({
              success: false,
              message:
                "Invalid start date/time."
            });
          }

          upi.startAt =
            date.toISOString();
        }
      }

      if (
        req.body.expiryAt !== undefined
      ) {
        if (!req.body.expiryAt) {
          upi.expiryAt = null;
        } else {
          const date = validDate(
            req.body.expiryAt
          );

          if (!date) {
            return res.status(400).json({
              success: false,
              message:
                "Invalid expiry date/time."
            });
          }

          upi.expiryAt =
            date.toISOString();
        }
      }

      if (
        upi.startAt &&
        upi.expiryAt &&
        new Date(
          upi.expiryAt
        ).getTime() <=
          new Date(
            upi.startAt
          ).getTime()
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Expiry must be later than start."
        });
      }

      if (
        req.body.enabled !== undefined
      ) {
        upi.enabled =
          Boolean(req.body.enabled);
      }

      upi.updatedAt =
        new Date().toISOString();

      writeDatabase(db);

      res.json({
        success: true,
        message: "UPI updated successfully.",
        upi: {
          ...upi,
          state: getUpiState(upi)
        }
      });
    } catch (error) {
      console.error(
        "Edit UPI error:",
        error
      );

      res.status(500).json({
        success: false,
        message: "Unable to update UPI."
      });
    }
  }
);

// =====================================================
// DELETE / ARCHIVE UPI
// =====================================================

app.delete(
  "/api/admin/upi/:id",
  adminOnly,
  (req, res) => {
    try {
      const db = readDatabase();

      const upi = db.upiLinks.find(
        (item) => item.id === req.params.id
      );

      if (!upi) {
        return res.status(404).json({
          success: false,
          message: "UPI not found."
        });
      }

      // Keep the record instead of permanently
      // deleting it, so old orders remain safe.
      upi.archived = true;
      upi.enabled = false;
      upi.updatedAt =
        new Date().toISOString();

      writeDatabase(db);

      res.json({
        success: true,
        message: "UPI archived successfully."
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        success: false,
        message: "Unable to archive UPI."
      });
    }
  }
);

// =====================================================
// UPDATE ORDER FROM ADMIN
// =====================================================

app.put(
  "/api/admin/orders/:id",
  adminOnly,
  (req, res) => {
    try {
      const db = readDatabase();

      const order = db.orders.find(
        (item) => item.id === req.params.id
      );

      if (!order) {
        return res.status(404).json({
          success: false,
          message: "Order not found."
        });
      }

      if (req.body.status !== undefined) {
        const allowedStatuses = [
          "pending",
          "processing",
          "completed",
          "rejected"
        ];

        const status = cleanString(
          req.body.status,
          50
        ).toLowerCase();

        if (
          !allowedStatuses.includes(status)
        ) {
          return res.status(400).json({
            success: false,
            message: "Invalid order status."
          });
        }

        order.status = status;
      }

      if (
        req.body.adminNote !== undefined
      ) {
        order.adminNote = cleanString(
          req.body.adminNote,
          1000
        );
      }

      order.updatedAt =
        new Date().toISOString();

      writeDatabase(db);

      res.json({
        success: true,
        message: "Order updated successfully."
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        success: false,
        message: "Unable to update order."
      });
    }
  }
);

// =====================================================
// STATIC WEBSITE
// =====================================================

app.use(
  express.static(
    path.join(__dirname, "public")
  )
);

// =====================================================
// PAGE ROUTES
// =====================================================

app.get("/", (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "index.html")
  );
});

app.get("/order", (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      "public",
      "order.html"
    )
  );
});

app.get("/status", (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      "public",
      "status.html"
    )
  );
});

app.get("/admin", (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      "public",
      "admin.html"
    )
  );
});

// =====================================================
// 404 API HANDLER
// =====================================================

app.use("/api", (req, res) => {
  res.status(404).json({
    success: false,
    message: "API endpoint not found."
  });
});

// =====================================================
// GENERAL ERROR HANDLER
// =====================================================

app.use((err, req, res, next) => {
  console.error(
    "Server error:",
    err
  );

  if (res.headersSent) {
    return next(err);
  }

  res.status(500).json({
    success: false,
    message: "Something went wrong."
  });
});

// =====================================================
// START SERVER
// =====================================================

ensureDatabase();

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Quick Exchange running on port ${PORT}`
    );

    console.log(
      `Admin username: ${ADMIN_USER}`
    );
  }
);
