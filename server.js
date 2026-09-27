const express = require("express");
const session = require("express-session");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const DB_FILE = path.join(__dirname, "data", "db.json");

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "change-me";
const SESSION_SECRET =
  process.env.SESSION_SECRET || "change-this-secret";


// ========================================
// DATABASE
// ========================================

function readDB() {
  try {
    return JSON.parse(
      fs.readFileSync(DB_FILE, "utf8")
    );
  } catch {
    return {
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
  }
}


function writeDB(db) {
  fs.mkdirSync(
    path.dirname(DB_FILE),
    {
      recursive: true
    }
  );

  fs.writeFileSync(
    DB_FILE,
    JSON.stringify(db, null, 2)
  );
}


// ========================================
// HELPERS
// ========================================

function generateId(prefix) {
  return (
    prefix +
    "-" +
    Date.now().toString(36).toUpperCase() +
    "-" +
    Math.random()
      .toString(36)
      .substring(2, 7)
      .toUpperCase()
  );
}


function isValidPaymentURL(value) {

  try {

    const url =
      new URL(value);

    return (
      url.protocol === "https:" ||
      url.protocol === "upi:"
    );

  } catch {

    return false;

  }
}


function isUPIActive(upi) {

  if (!upi) {
    return false;
  }

  if (upi.enabled === false) {
    return false;
  }

  if (upi.archivedAt) {
    return false;
  }

  const now = Date.now();


  if (
    upi.startAt &&
    new Date(upi.startAt).getTime() > now
  ) {
    return false;
  }


  if (
    upi.expiresAt &&
    new Date(upi.expiresAt).getTime() <= now
  ) {
    return false;
  }


  return true;
}


function adminOnly(req, res, next) {

  if (
    req.session &&
    req.session.admin === true
  ) {
    return next();
  }

  return res.status(401).json({
    error: "Unauthorized"
  });
}


// ========================================
// MIDDLEWARE
// ========================================

app.use(
  express.json({
    limit: "1mb"
  })
);

app.use(
  express.urlencoded({
    extended: true
  })
);


app.use(
  session({
    secret: SESSION_SECRET,

    resave: false,

    saveUninitialized: false,

    cookie: {
      httpOnly: true,
      sameSite: "lax",
      maxAge:
        8 * 60 * 60 * 1000
    }
  })
);


app.use(
  express.static(
    path.join(
      __dirname,
      "public"
    )
  )
);


// ========================================
// PUBLIC CONFIG
// ========================================

app.get(
  "/api/public",
  (req, res) => {

    const db = readDB();

    const activeUPI =
      (db.upiLinks || [])
        .filter(isUPIActive)
        .map(upi => ({
          id: upi.id,
          name: upi.name,
          url: upi.url
        }));


    res.json({

      siteName:
        db.settings.siteName,

      rates:
        db.settings.rates,

      feePercent:
        Number(
          db.settings.feePercent || 0
        ),

      minAmount:
        Number(
          db.settings.minAmount || 0
        ),

      maxAmount:
        Number(
          db.settings.maxAmount || 0
        ),

      methods:
        db.settings.methods || {},

      contact:
        db.settings.contact || {},

      upiLinks:
        activeUPI
    });

  }
);


// ========================================
// CREATE ORDER
// ========================================

app.post(
  "/api/orders",
  (req, res) => {

    const db = readDB();

    const {
      payMethod,
      receiveMethod,
      amount,
      receiver
    } = req.body;


    if (payMethod !== "upi") {

      return res.status(400).json({
        error:
          "UPI is currently the only payment method."
      });

    }


    const allowedMethods = [
      "easypaisa",
      "jazzcash",
      "usdt"
    ];


    if (
      !allowedMethods.includes(
        receiveMethod
      )
    ) {

      return res.status(400).json({
        error:
          "Invalid receiving method."
      });

    }


    if (
      db.settings.methods &&
      db.settings.methods[
        receiveMethod
      ] === false
    ) {

      return res.status(400).json({
        error:
          "This receiving method is currently unavailable."
      });

    }


    const sendAmount =
      Number(amount);


    if (
      !Number.isFinite(sendAmount) ||
      sendAmount <= 0
    ) {

      return res.status(400).json({
        error:
          "Please enter a valid amount."
      });

    }


    const minAmount =
      Number(
        db.settings.minAmount || 0
      );

    const maxAmount =
      Number(
        db.settings.maxAmount || Infinity
      );


    if (
      sendAmount < minAmount ||
      sendAmount > maxAmount
    ) {

      return res.status(400).json({
        error:
          `Amount must be between ${minAmount} and ${maxAmount}.`
      });

    }


    const rate =
      Number(
        db.settings.rates[
          receiveMethod
        ]
      );


    if (
      !Number.isFinite(rate) ||
      rate <= 0
    ) {

      return res.status(400).json({
        error:
          "Exchange rate is not configured."
      });

    }


    const feePercent =
      Number(
        db.settings.feePercent || 0
      );


    if (
      !Number.isFinite(feePercent) ||
      feePercent < 0 ||
      feePercent > 100
    ) {

      return res.status(400).json({
        error:
          "Invalid service fee configuration."
      });

    }


    // Calculate receive amount
    const grossReceive =
      sendAmount * rate;


    const feeAmount =
      grossReceive *
      (feePercent / 100);


    const finalReceive =
      grossReceive - feeAmount;


    // Basic receiver validation
    if (
      !receiver ||
      typeof receiver !== "object"
    ) {

      return res.status(400).json({
        error:
          "Receiving details are required."
      });

    }


    if (
      receiveMethod === "easypaisa" ||
      receiveMethod === "jazzcash"
    ) {

      if (
        !String(
          receiver.number || ""
        ).trim()
      ) {

        return res.status(400).json({
          error:
            "Receiving account number is required."
        });

      }

    }


    if (
      receiveMethod === "usdt"
    ) {

      if (
        !String(
          receiver.wallet || ""
        ).trim()
      ) {

        return res.status(400).json({
          error:
            "USDT wallet address is required."
        });

      }


      const networks = [
        "TRC20",
        "BEP20",
        "ERC20"
      ];


      if (
        !networks.includes(
          receiver.network
        )
      ) {

        return res.status(400).json({
          error:
            "Invalid USDT network."
        });

      }

    }


    const order = {

      id:
        generateId("EX"),

      createdAt:
        new Date().toISOString(),

      updatedAt:
        new Date().toISOString(),

      payMethod:
        "upi",

      receiveMethod:
        receiveMethod,

      sendAmount:
        sendAmount,

      // LOCKED RATE
      rate:
        rate,

      feePercent:
        feePercent,

      receiveAmount:
        Number(
          finalReceive.toFixed(8)
        ),

      receiver:
        receiver,

      paymentRef:
        "",

      selectedUpiId:
        "",

      status:
        "pending",

      note:
        ""
    };


    db.orders.unshift(order);

    writeDB(db);


    return res.json({
      ok: true,
      order
    });

  }
);


// ========================================
// PUBLIC ORDER
// ========================================

app.get(
  "/api/orders/:id",
  (req, res) => {

    const db = readDB();

    const order =
      (db.orders || [])
        .find(
          item =>
            item.id ===
            req.params.id
        );


    if (!order) {

      return res.status(404).json({
        error:
          "Order not found."
      });

    }


    // Only expose information needed
    // for the customer's order page.
    const safeOrder = {

      id:
        order.id,

      createdAt:
        order.createdAt,

      payMethod:
        order.payMethod,

      receiveMethod:
        order.receiveMethod,

      sendAmount:
        order.sendAmount,

      rate:
        order.rate,

      feePercent:
        order.feePercent,

      receiveAmount:
        order.receiveAmount,

      paymentRef:
        order.paymentRef || "",

      selectedUpiId:
        order.selectedUpiId || "",

      status:
        order.status

    };


    res.json({
      order:
        safeOrder
    });

  }
);


// ========================================
// CUSTOMER SUBMITS PAYMENT REFERENCE
// ========================================

app.put(
  "/api/orders/:id",
  (req, res) => {

    const db = readDB();

    const order =
      (db.orders || [])
        .find(
          item =>
            item.id ===
            req.params.id
        );


    if (!order) {

      return res.status(404).json({
        error:
          "Order not found."
      });

    }


    const paymentRef =
      String(
        req.body.paymentRef || ""
      ).trim();


    if (!paymentRef) {

      return res.status(400).json({
        error:
          "Payment reference is required."
      });

    }


    if (paymentRef.length > 100) {

      return res.status(400).json({
        error:
          "Payment reference is too long."
      });

    }


    // Customer can ONLY change paymentRef here.
    // They cannot change amount, rate,
    // receive amount, or status.

    order.paymentRef =
      paymentRef;

    order.updatedAt =
      new Date().toISOString();


    // Keep pending until admin verifies it.
    if (
      order.status === "pending"
    ) {
      order.status =
        "processing";
    }


    writeDB(db);


    const safeOrder = {

      id:
        order.id,

      createdAt:
        order.createdAt,

      payMethod:
        order.payMethod,

      receiveMethod:
        order.receiveMethod,

      sendAmount:
        order.sendAmount,

      rate:
        order.rate,

      feePercent:
        order.feePercent,

      receiveAmount:
        order.receiveAmount,

      paymentRef:
        order.paymentRef,

      selectedUpiId:
        order.selectedUpiId,

      status:
        order.status

    };


    res.json({
      ok: true,
      order:
        safeOrder
    });

  }
);


// ========================================
// CUSTOMER SELECTS UPI
// ========================================

app.post(
  "/api/orders/:id/select-upi",
  (req, res) => {

    const db = readDB();

    const order =
      db.orders.find(
        item =>
          item.id ===
          req.params.id
      );


    if (!order) {

      return res.status(404).json({
        error:
          "Order not found."
      });

    }


    const upiId =
      String(
        req.body.upiId || ""
      );


    const upi =
      db.upiLinks.find(
        item =>
          item.id === upiId
      );


    if (!upi) {

      return res.status(404).json({
        error:
          "UPI option not found."
      });

    }


    if (!isUPIActive(upi)) {

      return res.status(400).json({
        error:
          "This UPI option is no longer active."
      });

    }


    order.selectedUpiId =
      upi.id;

    order.updatedAt =
      new Date().toISOString();


    writeDB(db);


    res.json({
      ok: true
    });

  }
);


// ========================================
// ADMIN LOGIN
// ========================================

app.post(
  "/api/admin/login",
  (req, res) => {

    const username =
      String(
        req.body.username || ""
      );

    const password =
      String(
        req.body.password || ""
      );


    if (
      username === ADMIN_USER &&
      password === ADMIN_PASS
    ) {

      req.session.admin =
        true;


      return res.json({
        ok: true
      });

    }


    return res.status(401).json({
      error:
        "Invalid username or password."
    });

  }
);


// ========================================
// ADMIN LOGOUT
// ========================================

app.post(
  "/api/admin/logout",
  adminOnly,
  (req, res) => {

    req.session.destroy(
      () => {

        res.json({
          ok: true
        });

      }
    );

  }
);


// ========================================
// ADMIN DATA
// ========================================

app.get(
  "/api/admin/data",
  adminOnly,
  (req, res) => {

    const db = readDB();

    res.set(
      "Cache-Control",
      "no-store"
    );


    res.json(db);

  }
);


// ========================================
// ADMIN SETTINGS
// ========================================

app.put(
  "/api/admin/settings",
  adminOnly,
  (req, res) => {

    const db = readDB();

    const body =
      req.body;


    const easypaisaRate =
      Number(
        body.rates?.easypaisa
      );

    const jazzcashRate =
      Number(
        body.rates?.jazzcash
      );

    const usdtRate =
      Number(
        body.rates?.usdt
      );


    if (
      !Number.isFinite(
        easypaisaRate
      ) ||
      easypaisaRate <= 0 ||

      !Number.isFinite(
        jazzcashRate
      ) ||
      jazzcashRate <= 0 ||

      !Number.isFinite(
        usdtRate
      ) ||
      usdtRate <= 0
    ) {

      return res.status(400).json({
        error:
          "All exchange rates must be greater than zero."
      });

    }


    const feePercent =
      Number(
        body.feePercent ?? 0
      );


    const minAmount =
      Number(
        body.minAmount
      );


    const maxAmount =
      Number(
        body.maxAmount
      );


    if (
      !Number.isFinite(
        feePercent
      ) ||
      feePercent < 0 ||
      feePercent > 100
    ) {

      return res.status(400).json({
        error:
          "Invalid fee percentage."
      });

    }


    if (
      !Number.isFinite(
        minAmount
      ) ||
      minAmount < 0
    ) {

      return res.status(400).json({
        error:
          "Invalid minimum amount."
      });

    }


    if (
      !Number.isFinite(
        maxAmount
      ) ||
      maxAmount <= 0 ||
      maxAmount < minAmount
    ) {

      return res.status(400).json({
        error:
          "Invalid maximum amount."
      });

    }


    db.settings.siteName =
      String(
        body.siteName ||
        "Quick Exchange"
      ).trim();


    db.settings.rates = {

      easypaisa:
        easypaisaRate,

      jazzcash:
        jazzcashRate,

      usdt:
        usdtRate

    };


    db.settings.feePercent =
      feePercent;


    db.settings.minAmount =
      minAmount;


    db.settings.maxAmount =
      maxAmount;


    db.settings.methods = {

      easypaisa:
        Boolean(
          body.methods?.easypaisa
        ),

      jazzcash:
        Boolean(
          body.methods?.jazzcash
        ),

      usdt:
        Boolean(
          body.methods?.usdt
        )

    };


    db.settings.contact = {

      whatsapp:
        String(
          body.contact?.whatsapp || ""
        ).trim(),

      telegram:
        String(
          body.contact?.telegram || ""
        ).trim()

    };


    writeDB(db);


    res.json({
      ok: true,
      settings:
        db.settings
    });

  }
);


// ========================================
// ADD UPI LINK
// ========================================

app.post(
  "/api/admin/upi",
  adminOnly,
  (req, res) => {

    const db = readDB();

    const name =
      String(
        req.body.name || ""
      ).trim();

    const url =
      String(
        req.body.url || ""
      ).trim();


    if (!name) {

      return res.status(400).json({
        error:
          "UPI button name is required."
      });

    }


    if (!url) {

      return res.status(400).json({
        error:
          "UPI payment URL is required."
      });

    }


    if (
      !isValidPaymentURL(url)
    ) {

      return res.status(400).json({
        error:
          "Payment URL must use HTTPS or a UPI payment link."
      });

    }


    const upi = {

      id:
        generateId("UPI"),

      name:
        name,

      url:
        url,

      startAt:
        req.body.startAt ||
        null,

      expiresAt:
        req.body.expiresAt ||
        null,

      enabled:
        true,

      archivedAt:
        null,

      createdAt:
        new Date().toISOString()

    };


    db.upiLinks.push(upi);

    writeDB(db);


    res.json({
      ok: true,
      upi
    });

  }
);


// ========================================
// UPDATE UPI
// ========================================

app.put(
  "/api/admin/upi/:id",
  adminOnly,
  (req, res) => {

    const db = readDB();

    const upi =
      db.upiLinks.find(
        item =>
          item.id ===
          req.params.id
      );


    if (!upi) {

      return res.status(404).json({
        error:
          "UPI link not found."
      });

    }


    if (
      req.body.name !== undefined
    ) {

      const name =
        String(
          req.body.name
        ).trim();


      if (!name) {

        return res.status(400).json({
          error:
            "UPI name cannot be empty."
        });

      }


      upi.name =
        name;

    }


    if (
      req.body.url !== undefined
    ) {

      const url =
        String(
          req.body.url
        ).trim();


      if (
        !isValidPaymentURL(url)
      ) {

        return res.status(400).json({
          error:
            "Invalid payment URL."
        });

      }


      upi.url =
        url;

    }


    if (
      req.body.startAt !== undefined
    ) {

      upi.startAt =
        req.body.startAt ||
        null;

    }


    if (
      req.body.expiresAt !== undefined
    ) {

      upi.expiresAt =
        req.body.expiresAt ||
        null;

    }


    if (
      req.body.enabled !== undefined
    ) {

      upi.enabled =
        Boolean(
          req.body.enabled
        );

    }


    writeDB(db);


    res.json({
      ok: true,
      upi
    });

  }
);


// ========================================
// ARCHIVE UPI
// ========================================

app.delete(
  "/api/admin/upi/:id",
  adminOnly,
  (req, res) => {

    const db = readDB();

    const upi =
      db.upiLinks.find(
        item =>
          item.id ===
          req.params.id
      );


    if (!upi) {

      return res.status(404).json({
        error:
          "UPI link not found."
      });

    }


    // Archive instead of deleting history
    upi.enabled =
      false;

    upi.archivedAt =
      new Date().toISOString();


    writeDB(db);


    res.json({
      ok: true
    });

  }
);


// ========================================
// ADMIN UPDATE ORDER
// ========================================

app.put(
  "/api/admin/orders/:id",
  adminOnly,
  (req, res) => {

    const db = readDB();

    const order =
      db.orders.find(
        item =>
          item.id ===
          req.params.id
      );


    if (!order) {

      return res.status(404).json({
        error:
          "Order not found."
      });

    }


    const allowedStatuses = [
      "pending",
      "processing",
      "completed",
      "rejected"
    ];


    if (
      req.body.status !== undefined
    ) {

      if (
        !allowedStatuses.includes(
          req.body.status
        )
      ) {

        return res.status(400).json({
          error:
            "Invalid order status."
        });

      }


      order.status =
        req.body.status;

    }


    if (
      req.body.paymentRef !== undefined
    ) {

      order.paymentRef =
        String(
          req.body.paymentRef
        ).trim();

    }


    if (
      req.body.note !== undefined
    ) {

      order.note =
        String(
          req.body.note
        ).trim();

    }


    order.updatedAt =
      new Date().toISOString();


    writeDB(db);


    res.json({
      ok: true,
      order
    });

  }
);


// ========================================
// PAGES
// ========================================

app.get(
  "/admin",
  (req, res) => {

    res.sendFile(
      path.join(
        __dirname,
        "public",
        "admin.html"
      )
    );

  }
);


app.get(
  "/order",
  (req, res) => {

    res.sendFile(
      path.join(
        __dirname,
        "public",
        "order.html"
      )
    );

  }
);


app.get(
  "/status",
  (req, res) => {

    res.sendFile(
      path.join(
        __dirname,
        "public",
        "status.html"
      )
    );

  }
);


// ========================================
// START
// ========================================

app.listen(
  PORT,
  () => {

    console.log(
      `Quick Exchange running on port ${PORT}`
    );

  }
);
