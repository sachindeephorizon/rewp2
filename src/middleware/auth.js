const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "deephorizon_secret_change_me";

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No token provided" });
  }

  try {
    const token = header.split(" ")[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded; // { id, email, name }
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, name: user.name },
    JWT_SECRET,
    { expiresIn: "30d" }
  );
}

module.exports = { authMiddleware, signToken, JWT_SECRET };
