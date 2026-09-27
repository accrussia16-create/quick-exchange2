const express = require("express");
const session = require("express-session");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();

const PORT = process.env.PORT || 3000;

const DB_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DB_DIR, "db.json");

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "change-me";

const SESSION_SECRET =
  process.env.SESSION_SECRET || "dev-secret-change-me";

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

/* =========================================================
   DATABASE
========================================================= */

function ensureDatabase() {
  fs.mkdirSync(DB_DIR, { recursive: true });

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
      ...DEFAULT_DB,
      ...parsed,

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
    throw new Error("Database file contains invalid JSON.");
  }
}

function writeDatabase(db) {
  ensureDatabase();

  const temporaryFile = `${DB_FILE}.tmp`;

  fs.writeFileSync(
    temporaryFile,
    JSON.stringify(db, null, 2),
    "utf8"
  );

  fs.renameSync(temporaryFile, DB_FILE);
}

/* =========================================================
   HELPERS
========================================================= */

function cleanText(value, maxLength = 500) {
  return String(value ?? "")
    .trim()
    .slice(0, maxLength);
}

function isValidDate(value) {
  const date = new Date(value);

  return !Number.isNaN(date.getTime());
}

function isValidUrl(value) {
  try {
    const url = new URL(value);

    return (
      url.protocol === "http:" ||
      url.protocol === "https:"
    );
  } catch {
    return false;
  }
}

function normalizeReceiveMethod(value) {
  const allowed = [
    "easypaisa",
    "jazzcash",
    "usdt"
  ];

  return allowed.includes(value)
    ? value
    : null;
}

function calculateReceiveAmount(
  amount,
  rate,
  feePercent
) {
  const gross = amount * rate;

  const fee =
    gross * (Number(feePercent) / 100);

  return Math.max(0, gross - fee);
}

function generateOrderId() {
  return (
    "QE-" +
    Date.now().toString(36).toUpperCase() +
    "-" +
    crypto
      .randomBytes(3)
      .toString("hex")
      .toUpperCase()
  );
}

function generateUpiId() {
  return (
    "UPI-" +
    crypto
      .randomBytes(5)
      .toString("hex")
      .toUpperCase()
  );
}

/* =========================================================
   UPI STATUS
========================================================= */

function getUpiState(upi) {
  if (upi.archivedAt) {
    return "archived";
  }

  if (upi.enabled === false) {
    return "disabled";
  }

  const now = Date.now();

  const start = new Date(
    upi.startAt
  ).getTime();

  if (!Number.isFinite(start)) {
    return "scheduled";
  }

  if (now < start) {
    return "scheduled";
  }

  if (upi.expiresAt) {
    const expiry = new Date(
      upi.expiresAt
    ).getTime();

    if (
      Number.isFinite(expiry) &&
      now >= expiry
    ) {
      return "expired";
    }
  }

  return "active";
}

function getActivePublicUpis(db) {
  return db.upiLinks
    .filter((upi) => {
      return getUpiState(upi) === "active";
    })
    .map((upi) => ({
      id: upi.id,
      name: upi.name,
      url: upi.url,
      startAt: upi.startAt,
      expiresAt: upi.expiresAt || null
    }));
}

/* =========================================================
   ADMIN AUTH
========================================================= */

function adminOnly(req, res, next) {
  if (req.session?.admin === true) {
    return next();
  }

  return res.status(401).json({
    error: "Unauthorized"
  });
}

/* =========================================================
   MIDDLEWARE
========================================================= */

app.disable("x-powered-by");

app.use(
  express.json({
    limit: "50kb"
  })
);

app.use(
  express.urlencoded({
    extended: false
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

      secure:
        process.env.NODE_ENV ===
        "production",

      maxAge:
        8 * 60 * 60 * 1000
    }
  })
);

app.use(
  express.static(
    path.join(__dirname, "public")
  )
);

/* =========================================================
   PAGE ROUTES
========================================================= */

app.get("/", (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      "public",
      "index.html"
    )
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

/* =========================================================
   PUBLIC CONFIGURATION
========================================================= */

app.get("/api/public", (req, res) => {
  const db = readDatabase();

  res.json({
    siteName: db.settings.siteName,

    rates: db.settings.rates,

    feePercent:
      Number(db.settings.feePercent) || 0,

    minAmount:
      Number(db.settings.minAmount) || 0,

    maxAmount:
      Number(db.settings.maxAmount) || 0,

    methods: db.settings.methods,

    contact: db.settings.contact,

    upiLinks:
      getActivePublicUpis(db)
  });
});

/* =========================================================
   CREATE ORDER
========================================================= */

app.post("/api/orders", (req, res) => {
  try {
    const db = readDatabase();

    const amount = Number(req.body.amount);

    const receiveMethod =
      normalizeReceiveMethod(
        req.body.receiveMethod
      );

    if (!Number.isFinite(amount)) {
      return res.status(400).json({
        error: "Enter a valid amount."
      });
    }

    if (
      amount <
      Number(db.settings.minAmount)
    ) {
      return res.status(400).json({
        error:
          `Minimum amount is ${db.settings.minAmount}.`
      });
    }

    if (
      amount >
      Number(db.settings.maxAmount)
    ) {
      return res.status(400).json({
        error:
          `Maximum amount is ${db.settings.maxAmount}.`
      });
    }

    if (
      !receiveMethod ||
      db.settings.methods[
        receiveMethod
      ] !== true
    ) {
      return res.status(400).json({
        error:
          "Selected receive method is unavailable."
      });
    }

    const receiver =
      req.body.receiver || {};

    let receiverData = {};

    if (
      receiveMethod ===
        "easypaisa" ||
      receiveMethod ===
        "jazzcash"
    ) {
      const number =
        cleanText(
          receiver.number,
          50
        );

      const name =
        cleanText(
          receiver.name,
          100
        );

      if (!number || !name) {
        return res.status(400).json({
          error:
            "Receiver name and number are required."
        });
      }

      receiverData = {
        number,
        name
      };
    }

    if (
      receiveMethod ===
      "usdt"
    ) {
      const wallet =
        cleanText(
          receiver.wallet,
          200
        );

      const network =
        cleanText(
          receiver.network,
          20
        );

      const allowedNetworks = [
        "TRC20",
        "BEP20",
        "ERC20"
      ];

      if (
        !wallet ||
        !allowedNetworks.includes(
          network
        )
      ) {
        return res.status(400).json({
          error:
            "USDT wallet and valid network are required."
        });
      }

      receiverData = {
        wallet,
        network
      };
    }

    const rate =
      Number(
        db.settings.rates[
          receiveMethod
        ]
      );

    const feePercent =
      Number(
        db.settings.feePercent
      ) || 0;

    if (
      !Number.isFinite(rate) ||
      rate <= 0
    ) {
      return res.status(500).json({
        error:
          "Exchange rate is not configured."
      });
    }

    const receiveAmount =
      calculateReceiveAmount(
        amount,
        rate,
        feePercent
      );

    const now =
      new Date().toISOString();

    const order = {
      id: generateOrderId(),

      createdAt: now,

      updatedAt: now,

      amount,

      receiveMethod,

      receiver: receiverData,

      lockedRate: rate,

      feePercent,

      receiveAmount,

      status: "pending",

      paymentReference: "",

      selectedUpiId: null,

      adminNote: ""
    };

    db.orders.unshift(order);

    writeDatabase(db);

    return res.status(201).json({
      order: {
        id: order.id,

        createdAt:
          order.createdAt,

        amount:
          order.amount,

        receiveMethod:
          order.receiveMethod,

        lockedRate:
          order.lockedRate,

        feePercent:
          order.feePercent,

        receiveAmount:
          order.receiveAmount,

        status:
          order.status
      }
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error:
        "Unable to create order."
    });
  }
});

/* =========================================================
   GET CUSTOMER ORDER
========================================================= */

app.get(
  "/api/orders/:id",
  (req, res) => {
    try {
      const db =
        readDatabase();

      const order =
        db.orders.find(
          (item) =>
            item.id ===
            req.params.id
        );

      if (!order) {
        return res.status(404).json({
          error:
            "Order not found."
        });
      }

      return res.json({
        order: {
          id: order.id,

          createdAt:
            order.createdAt,

          updatedAt:
            order.updatedAt,

          amount:
            order.amount,

          receiveMethod:
            order.receiveMethod,

          receiver:
            order.receiver,

          lockedRate:
            order.lockedRate,

          feePercent:
            order.feePercent,

          receiveAmount:
            order.receiveAmount,

          status:
            order.status,

          paymentReference:
            order.paymentReference ||
            "",

          selectedUpiId:
            order.selectedUpiId ||
            null,

          adminNote:
            order.adminNote ||
            ""
        }
      });
    } catch {
      return res.status(500).json({
        error:
          "Unable to load order."
      });
    }
  }
);

/* =========================================================
   CUSTOMER PAYMENT REFERENCE
========================================================= */

app.put(
  "/api/orders/:id",
  (req, res) => {
    try {
      const db =
        readDatabase();

      const order =
        db.orders.find(
          (item) =>
            item.id ===
            req.params.id
        );

      if (!order) {
        return res.status(404).json({
          error:
            "Order not found."
        });
      }

      if (
        req.body.paymentReference !==
        undefined
      ) {
        const reference =
          cleanText(
            req.body.paymentReference,
            200
          );

        if (!reference) {
          return res.status(400).json({
            error:
              "Payment reference is required."
          });
        }

        order.paymentReference =
          reference;

        if (
          order.status ===
          "pending"
        ) {
          order.status =
            "processing";
        }
      }

      order.updatedAt =
        new Date().toISOString();

      writeDatabase(db);

      return res.json({
        ok: true,

        order: {
          id: order.id,

          status:
            order.status,

          paymentReference:
            order.paymentReference
        }
      });
    } catch {
      return res.status(500).json({
        error:
          "Unable to update order."
      });
    }
  }
);

/* =========================================================
   SELECT UPI
========================================================= */

app.post(
  "/api/orders/:id/select-upi",
  (req, res) => {
    try {
      const db =
        readDatabase();

      const order =
        db.orders.find(
          (item) =>
            item.id ===
            req.params.id
        );

      if (!order) {
        return res.status(404).json({
          error:
            "Order not found."
        });
      }

      const upi =
        db.upiLinks.find(
          (item) =>
            item.id ===
            req.body.upiId
        );

      if (
        !upi ||
        getUpiState(upi) !==
          "active"
      ) {
        return res.status(400).json({
          error:
            "This UPI payment option is no longer active."
        });
      }

      order.selectedUpiId =
        upi.id;

      order.updatedAt =
        new Date().toISOString();

      writeDatabase(db);

      return res.json({
        ok: true,

        url: upi.url
      });
    } catch {
      return res.status(500).json({
        error:
          "Unable to select UPI."
      });
    }
  }
);

/* =========================================================
   ADMIN LOGIN
========================================================= */

app.post(
  "/api/admin/login",
  (req, res) => {
    const username =
      cleanText(
        req.body.username,
        100
      );

    const password =
      String(
        req.body.password ?? ""
      );

    if (
      username ===
        ADMIN_USER &&
      password ===
        ADMIN_PASS
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

/* =========================================================
   ADMIN LOGOUT
========================================================= */

app.post(
  "/api/admin/logout",
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

/* =========================================================
   ADMIN SESSION
========================================================= */

app.get(
  "/api/admin/me",
  (req, res) => {
    res.json({
      authenticated:
        req.session?.admin ===
        true
    });
  }
);

/* =========================================================
   ADMIN DATA
========================================================= */

app.get(
  "/api/admin/data",
  adminOnly,
  (req, res) => {
    const db =
      readDatabase();

    res.json({
      settings:
        db.settings,

      upiLinks:
        db.upiLinks.map(
          (upi) => ({
            ...upi,

            state:
              getUpiState(upi)
          })
        ),

      orders:
        db.orders
    });
  }
);

/* =========================================================
   ADMIN SETTINGS
========================================================= */

app.put(
  "/api/admin/settings",
  adminOnly,
  (req, res) => {
    try {
      const db =
        readDatabase();

      const body =
        req.body || {};

      const siteName =
        cleanText(
          body.siteName,
          100
        ) ||
        "Quick Exchange";

      const feePercent =
        Number(
          body.feePercent
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
        ![
          feePercent,
          minAmount,
          maxAmount
        ].every(
          Number.isFinite
        )
      ) {
        return res.status(400).json({
          error:
            "Invalid settings."
        });
      }

      if (
        feePercent < 0 ||
        feePercent > 100
      ) {
        return res.status(400).json({
          error:
            "Fee must be between 0 and 100."
        });
      }

      if (
        minAmount < 0 ||
        maxAmount <= minAmount
      ) {
        return res.status(400).json({
          error:
            "Invalid minimum or maximum amount."
        });
      }

      const rates = {
        easypaisa:
          Number(
            body.rates?.easypaisa
          ),

        jazzcash:
          Number(
            body.rates?.jazzcash
          ),

        usdt:
          Number(
            body.rates?.usdt
          )
      };

      if (
        Object.values(
          rates
        ).some(
          (value) =>
            !Number.isFinite(
              value
            ) ||
            value <= 0
        )
      ) {
        return res.status(400).json({
          error:
            "All exchange rates must be positive."
        });
      }

      db.settings = {
        ...db.settings,

        siteName,

        feePercent,

        minAmount,

        maxAmount,

        rates,

        methods: {
          easypaisa:
            body.methods
              ?.easypaisa ===
            true,

          jazzcash:
            body.methods
              ?.jazzcash ===
            true,

          usdt:
            body.methods
              ?.usdt ===
            true
        },

        contact: {
          whatsapp:
            cleanText(
              body.contact
                ?.whatsapp,
              300
            ),

          telegram:
            cleanText(
              body.contact
                ?.telegram,
              300
            )
        }
      };

      writeDatabase(db);

      res.json({
        ok: true,

        settings:
          db.settings
      });
    } catch {
      res.status(500).json({
        error:
          "Unable to save settings."
      });
    }
  }
);

/* =========================================================
   CREATE UPI
========================================================= */

app.post(
  "/api/admin/upi",
  adminOnly,
  (req, res) => {
    try {
      const db =
        readDatabase();

      const name =
        cleanText(
          req.body.name,
          100
        );

      const url =
        cleanText(
          req.body.url,
          500
        );

      const startAt =
        req.body.startAt;

      const expiresAt =
        req.body.expiresAt ||
        null;

      if (
        !name ||
        !url ||
        !isValidUrl(url)
      ) {
        return res.status(400).json({
          error:
            "Valid UPI name and URL are required."
        });
      }

      if (
        !isValidDate(startAt)
      ) {
        return res.status(400).json({
          error:
            "Invalid start date."
        });
      }

      if (
        expiresAt &&
        !isValidDate(expiresAt)
      ) {
        return res.status(400).json({
          error:
            "Invalid expiry date."
        });
      }

      if (
        expiresAt &&
        new Date(expiresAt) <=
          new Date(startAt)
      ) {
        return res.status(400).json({
          error:
            "Expiry must be after start."
        });
      }

      const upi = {
        id: generateUpiId(),

        name,

        url,

        startAt:
          new Date(
            startAt
          ).toISOString(),

        expiresAt:
          expiresAt
            ? new Date(
                expiresAt
              ).toISOString()
            : null,

        enabled: true,

        archivedAt: null,

        createdAt:
          new Date().toISOString()
      };

      db.upiLinks.push(upi);

      writeDatabase(db);

      res.status(201).json({
        upi: {
          ...upi,

          state:
            getUpiState(upi)
        }
      });
    } catch {
      res.status(500).json({
        error:
          "Unable to create UPI."
      });
    }
  }
);

/* =========================================================
   UPDATE UPI
========================================================= */

app.put(
  "/api/admin/upi/:id",
  adminOnly,
  (req, res) => {
    try {
      const db =
        readDatabase();

      const upi =
        db.upiLinks.find(
          (item) =>
            item.id ===
            req.params.id
        );

      if (!upi) {
        return res.status(404).json({
          error:
            "UPI not found."
        });
      }

      const body =
        req.body || {};

      if (
        body.name !==
        undefined
      ) {
        upi.name =
          cleanText(
            body.name,
            100
          );
      }

      if (
        body.url !==
        undefined
      ) {
        const url =
          cleanText(
            body.url,
            500
          );

        if (
          !isValidUrl(url)
        ) {
          return res.status(400).json({
            error:
              "Invalid UPI URL."
          });
        }

        upi.url = url;
      }

      if (
        body.startAt !==
        undefined
      ) {
        if (
          !isValidDate(
            body.startAt
          )
        ) {
          return res.status(400).json({
            error:
              "Invalid start date."
          });
        }

        upi.startAt =
          new Date(
            body.startAt
          ).toISOString();
      }

      if (
        body.expiresAt !==
        undefined
      ) {
        if (
          body.expiresAt ===
            null ||
          body.expiresAt ===
            ""
        ) {
          upi.expiresAt =
            null;
        } else {
          if (
            !isValidDate(
              body.expiresAt
            )
          ) {
            return res.status(400).json({
              error:
                "Invalid expiry date."
            });
          }

          upi.expiresAt =
            new Date(
              body.expiresAt
            ).toISOString();
        }
      }

      if (
        upi.expiresAt &&
        new Date(
          upi.expiresAt
        ) <=
          new Date(
            upi.startAt
          )
      ) {
        return res.status(400).json({
          error:
            "Expiry must be after start."
        });
      }

      if (
        body.enabled !==
        undefined
      ) {
        upi.enabled =
          body.enabled ===
          true;
      }

      writeDatabase(db);

      res.json({
        upi: {
          ...upi,

          state:
            getUpiState(upi)
        }
      });
    } catch {
      res.status(500).json({
        error:
          "Unable to update UPI."
      });
    }
  }
);

/* =========================================================
   ARCHIVE UPI
========================================================= */

app.delete(
  "/api/admin/upi/:id",
  adminOnly,
  (req, res) => {
    const db =
      readDatabase();

    const upi =
      db.upiLinks.find(
        (item) =>
          item.id ===
          req.params.id
      );

    if (!upi) {
      return res.status(404).json({
        error:
          "UPI not found."
      });
    }

    upi.archivedAt =
      new Date().toISOString();

    upi.enabled = false;

    writeDatabase(db);

    res.json({
      ok: true
    });
  }
);

/* =========================================================
   ADMIN ORDER UPDATE
========================================================= */

app.put(
  "/api/admin/orders/:id",
  adminOnly,
  (req, res) => {
    const db =
      readDatabase();

    const order =
      db.orders.find(
        (item) =>
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
      req.body.status !==
      undefined
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
      req.body.adminNote !==
      undefined
    ) {
      order.adminNote =
        cleanText(
          req.body.adminNote,
          1000
        );
    }

    order.updatedAt =
      new Date().toISOString();

    writeDatabase(db);

    res.json({
      ok: true,

      order
    });
  }
);

/* =========================================================
   API 404
========================================================= */

app.use(
  (req, res, next) => {
    if (
      req.path.startsWith(
        "/api/"
      )
    ) {
      return res.status(404).json({
        error:
          "API endpoint not found."
      });
    }

    next();
  }
);

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
  (error, req, res, next) => {
    console.error(error);

    if (
      req.path.startsWith(
        "/api/"
      )
    ) {
      return res.status(500).json({
        error:
          "Internal server error."
      });
    }

    res.status(500).send(
      "Internal server error."
    );
  }
);

/* =========================================================
   START
========================================================= */

ensureDatabase();

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Quick Exchange running on port ${PORT}`
    );
  }
);
