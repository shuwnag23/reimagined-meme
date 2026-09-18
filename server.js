const http = require("http");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const vm = require("vm");

const ROOT = __dirname;
const DATA_DIR = path.resolve(process.env.PICKUP_DATA_DIR || path.join(ROOT, "data"));
const UPLOAD_DIR = path.resolve(process.env.PICKUP_UPLOAD_DIR || path.join(ROOT, "uploads"));
const DATA_FILE = path.join(DATA_DIR, "store.json");
const PORT = Number(process.env.PORT || 3000);
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const MAX_REQUEST_SIZE = 200 * 1024 * 1024;
const ADMIN_SESSION_TTL = 12 * 60 * 60;
const ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || crypto.createHash("sha256").update("pickup-admin:" + ADMIN_PASSWORD).digest("hex");

let mutationQueue = Promise.resolve();

function uid(prefix) {
  return (prefix || "id") + "-" + Date.now().toString(36) + "-" + crypto.randomBytes(6).toString("hex");
}

function token() {
  return crypto.randomBytes(24).toString("hex");
}

function normalized(value) {
  return String(value || "").trim().replace(/\s+/g, "").toUpperCase();
}

function safeFileName(value) {
  return String(value || "download").replace(/[\\/:*?"<>|\x00-\x1f]+/g, "_").trim() || "download";
}

function defaultDb() {
  return { version: 1, products: [], archives: [], claims: {}, generatedCodes: [] };
}

function loadSeedConfig() {
  try {
    const source = fs.readFileSync(path.join(ROOT, "config.js"), "utf8");
    const sandbox = { window: {} };
    vm.runInNewContext(source, sandbox, { timeout: 1000 });
    return sandbox.window.PICKUP_CONFIG || {};
  } catch (error) {
    return {};
  }
}

function normalizeInventory(item) {
  const value = item || {};
  return {
    id: value.id || uid("inventory"),
    name: value.name || "商品文件",
    type: value.type || "FILE",
    size: value.size || "",
    storageName: value.storageName || "",
    sourcePath: value.sourcePath || value.path || "",
    downloadToken: value.downloadToken || token()
  };
}

function normalizeProduct(product) {
  const value = product || {};
  const legacyFiles = Array.isArray(value.files) ? value.files : [];
  const inventory = Array.isArray(value.inventory) ? value.inventory : legacyFiles;
  const codes = Array.isArray(value.codes) ? value.codes : (value.code ? [value.code] : []);
  return {
    id: value.id || uid("product"),
    title: value.title || "未命名商品",
    subtitle: value.subtitle || "",
    category: value.category || "商品文件",
    codes: codes.map(normalized).filter(Boolean),
    inventory: inventory.map(normalizeInventory)
  };
}

function normalizeArchive(archive) {
  const value = archive || {};
  return {
    id: value.id || uid("archive"),
    productId: value.productId || "",
    productTitle: value.productTitle || "商品池",
    code: normalized(value.code),
    inventory: normalizeInventory(value.inventory),
    claimedAt: value.claimedAt || "",
    archivedAt: value.archivedAt || new Date().toISOString()
  };
}

function normalizeDb(value) {
  const source = value || defaultDb();
  const db = {
    version: 1,
    products: Array.isArray(source.products) ? source.products.map(normalizeProduct) : [],
    archives: Array.isArray(source.archives) ? source.archives.map(normalizeArchive) : [],
    claims: source.claims && typeof source.claims === "object" ? source.claims : {},
    generatedCodes: Array.isArray(source.generatedCodes) ? source.generatedCodes : []
  };
  return db;
}

async function ensureStorage() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(UPLOAD_DIR, { recursive: true });
  try {
    await fsp.access(DATA_FILE);
  } catch (error) {
    const config = loadSeedConfig();
    const initial = defaultDb();
    initial.products = Array.isArray(config.products) ? config.products.map(normalizeProduct) : [];
    await writeDb(initial);
  }
}

async function readDb() {
  const raw = await fsp.readFile(DATA_FILE, "utf8");
  return normalizeDb(JSON.parse(raw));
}

async function writeDb(db) {
  const tempFile = DATA_FILE + ".tmp";
  await fsp.writeFile(tempFile, JSON.stringify(normalizeDb(db), null, 2), "utf8");
  await fsp.rename(tempFile, DATA_FILE);
}

function mutate(mutator) {
  const operation = mutationQueue.then(async function () {
    const db = await readDb();
    const result = await mutator(db);
    await writeDb(db);
    return result;
  });
  mutationQueue = operation.catch(function () {});
  return operation;
}

function publicInventory(item) {
  const value = normalizeInventory(item);
  return {
    id: value.id,
    name: value.name,
    type: value.type,
    size: value.size,
    path: "/api/files/" + encodeURIComponent(value.id) + "?token=" + encodeURIComponent(value.downloadToken)
  };
}

function publicProduct(product) {
  return {
    id: product.id,
    title: product.title,
    subtitle: product.subtitle,
    category: product.category,
    inventory: product.inventory.map(publicInventory)
  };
}

function publicAssignment(archive) {
  return {
    id: archive.id,
    product: {
      id: archive.productId,
      title: archive.productTitle,
      subtitle: "文件已准备好，可以开始下载。",
      category: "商品文件"
    },
    inventoryItem: publicInventory(archive.inventory)
  };
}

function adminProduct(product) {
  const value = publicProduct(product);
  value.codes = product.codes.slice();
  return value;
}

function adminArchive(archive) {
  return {
    id: archive.id,
    productId: archive.productId,
    productTitle: archive.productTitle,
    code: archive.code,
    inventory: publicInventory(archive.inventory),
    claimedAt: archive.claimedAt,
    archivedAt: archive.archivedAt
  };
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
  return true;
}

function text(res, status, value) {
  const body = String(value || "");
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
  return true;
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function parseCookies(req) {
  const cookies = {};
  String(req.headers.cookie || "").split(";").forEach(function (part) {
    const index = part.indexOf("=");
    if (index < 0) return;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) cookies[name] = decodeURIComponent(value);
  });
  return cookies;
}

function signSession(payload) {
  return crypto.createHmac("sha256", ADMIN_SESSION_SECRET).update(payload).digest("hex");
}

function usesHttps(req) {
  return Boolean(req.socket && req.socket.encrypted) || String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https";
}

function sessionCookieSecurity(req) {
  return usesHttps(req) ? "; Secure" : "";
}

function createSessionCookie(req) {
  const expiresAt = Date.now() + ADMIN_SESSION_TTL * 1000;
  const payload = ADMIN_USER + ":" + expiresAt;
  const value = Buffer.from(payload + ":" + signSession(payload)).toString("base64url");
  return "pickup_admin=" + encodeURIComponent(value) + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + ADMIN_SESSION_TTL + sessionCookieSecurity(req);
}

function clearSessionCookie(req) {
  return "pickup_admin=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" + sessionCookieSecurity(req);
}

function isAdmin(req) {
  if (!ADMIN_PASSWORD) return false;
  try {
    const cookie = parseCookies(req).pickup_admin;
    if (!cookie) return false;
    const decoded = Buffer.from(cookie, "base64url").toString("utf8");
    const parts = decoded.split(":");
    if (parts.length !== 3) return false;
    const user = parts[0];
    const expiresAt = Number(parts[1]);
    const signature = parts[2];
    const payload = user + ":" + expiresAt;
    return user === ADMIN_USER && expiresAt > Date.now() && safeEqual(signature, signSession(payload));
  } catch (error) {
    return false;
  }
}

function requireAdmin(req, res) {
  if (!isAdmin(req)) {
    json(res, 401, { message: "请先登录配置中心" });
    return false;
  }
  return true;
}

function readBody(req, limit) {
  const max = limit || MAX_REQUEST_SIZE;
  return new Promise(function (resolve, reject) {
    let size = 0;
    const chunks = [];
    req.on("data", function (chunk) {
      size += chunk.length;
      if (size > max) {
        reject(new Error("请求内容过大"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", function () { resolve(Buffer.concat(chunks)); });
    req.on("error", reject);
  });
}

async function readJson(req) {
  const body = await readBody(req, 10 * 1024 * 1024);
  if (!body.length) return {};
  return JSON.parse(body.toString("utf8"));
}

function parseMultipart(body, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  if (!match) throw new Error("上传请求缺少 boundary");
  const boundary = Buffer.from("--" + (match[1] || match[2]));
  const parts = [];
  let cursor = body.indexOf(boundary);
  while (cursor !== -1) {
    const start = cursor + boundary.length;
    if (body.slice(start, start + 2).toString() === "--") break;
    const headerStart = start + 2;
    const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), headerStart);
    if (headerEnd === -1) break;
    const nextBoundary = body.indexOf(boundary, headerEnd + 4);
    if (nextBoundary === -1) break;
    const headers = body.slice(headerStart, headerEnd).toString("utf8");
    const content = body.slice(headerEnd + 4, nextBoundary - 2);
    const nameMatch = /name="([^"]+)"/i.exec(headers);
    const filenameMatch = /filename="([^"]*)"/i.exec(headers);
    if (nameMatch) {
      parts.push({ name: nameMatch[1], filename: filenameMatch ? filenameMatch[1] : "", data: content });
    }
    cursor = nextBoundary;
  }
  return parts;
}

function productById(db, id) {
  return db.products.find(function (product) { return product.id === id; });
}

function findInventory(db, id) {
  for (const product of db.products) {
    const item = product.inventory.find(function (inventory) { return inventory.id === id; });
    if (item) return item;
  }
  for (const archive of db.archives) {
    if (archive.inventory && archive.inventory.id === id) return archive.inventory;
  }
  return null;
}

function removeClaimAndArchive(db, code) {
  delete db.claims[code];
  db.archives = db.archives.filter(function (archive) { return archive.code !== code; });
}

function removeInventoryRecords(db, productId, inventoryIds) {
  const ids = inventoryIds;
  Object.keys(db.claims).forEach(function (code) {
    const claim = db.claims[code];
    if (claim && claim.productId === productId && ids.indexOf(claim.inventoryId) !== -1) {
      delete db.claims[code];
      db.archives = db.archives.filter(function (archive) { return archive.code !== code; });
    }
  });
  db.archives = db.archives.filter(function (archive) {
    return !(archive.productId === productId && archive.inventory && ids.indexOf(archive.inventory.id) !== -1);
  });
}

function randomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(8);
  let value = "";
  for (let i = 0; i < bytes.length; i += 1) value += alphabet[bytes[i] % alphabet.length];
  return "CARD-" + value.slice(0, 4) + "-" + value.slice(4);
}

function generateUniqueCodes(db, count) {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  db.generatedCodes = db.generatedCodes.filter(function (entry) { return entry && Number(entry.generatedAt) >= cutoff; });
  const used = {};
  db.products.forEach(function (product) { product.codes.forEach(function (code) { used[code] = true; }); });
  db.archives.forEach(function (archive) { used[archive.code] = true; });
  db.generatedCodes.forEach(function (entry) { used[normalized(entry.code)] = true; });
  const generated = [];
  while (generated.length < count) {
    const code = randomCode();
    if (used[code]) continue;
    used[code] = true;
    generated.push(code);
  }
  const now = Date.now();
  db.generatedCodes = db.generatedCodes.concat(generated.map(function (code) { return { code: code, generatedAt: now }; }));
  return generated;
}

async function handlePublic(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/public/state") {
    const db = await readDb();
    return json(res, 200, { products: db.products.map(function (product) {
      return { id: product.id, title: product.title, inventoryCount: product.inventory.length };
    }) });
  }

  if (req.method === "POST" && url.pathname === "/api/public/claim") {
    const body = await readJson(req);
    const codes = Array.isArray(body.codes) ? body.codes.map(normalized).filter(Boolean) : [];
    if (!codes.length || codes.length > 100) return json(res, 400, { message: "兑换码数量不正确" });
    const result = await mutate(function (db) {
      const assignments = [];
      const failures = [];
      codes.forEach(function (code) {
        const product = db.products.find(function (item) { return item.codes.indexOf(code) !== -1; });
        if (!product) {
          const used = db.claims[code] || db.archives.some(function (archive) { return archive.code === code; });
          failures.push({ code: code, message: used ? "该兑换码已经兑换，请切换到查找模式。" : "兑换码无效，请检查后重试。" });
          return;
        }
        const inventoryItem = product.inventory.shift();
        if (!inventoryItem) {
          failures.push({ code: code, message: "当前商品库存已发完。" });
          return;
        }
        product.codes = product.codes.filter(function (item) { return item !== code; });
        const claimedAt = new Date().toISOString();
        const archive = {
          id: uid("archive"),
          productId: product.id,
          productTitle: product.title,
          code: code,
          inventory: inventoryItem,
          claimedAt: claimedAt,
          archivedAt: claimedAt
        };
        db.claims[code] = { productId: product.id, inventoryId: inventoryItem.id, claimedAt: claimedAt, archiveId: archive.id };
        db.archives.push(archive);
        assignments.push({
          code: code,
          product: { id: product.id, title: product.title, subtitle: product.subtitle, category: product.category },
          inventoryItem: publicInventory(inventoryItem)
        });
      });
      return { assignments: assignments, failures: failures };
    });
    return json(res, 200, result);
  }

  if (req.method === "POST" && url.pathname === "/api/public/lookup") {
    const body = await readJson(req);
    const codes = Array.isArray(body.codes) ? body.codes.map(normalized).filter(Boolean) : [];
    const db = await readDb();
    const assignments = [];
    const failures = [];
    codes.forEach(function (code) {
      const archive = db.archives.find(function (item) { return item.code === code; });
      if (archive) assignments.push({ code: code, ...publicAssignment(archive) });
      else failures.push({ code: code, message: "没有找到已兑换记录，请确认兑换码。" });
    });
    return json(res, 200, { assignments: assignments, failures: failures });
  }

  return false;
}

async function handleAdmin(req, res, url) {
  if (req.method === "POST" && url.pathname === "/api/admin/login") {
    const credentials = await readJson(req);
    const user = String(credentials.user || "");
    const password = String(credentials.password || "");
    if (ADMIN_PASSWORD && user === ADMIN_USER && safeEqual(password, ADMIN_PASSWORD)) {
      const body = JSON.stringify({ ok: true });
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Length": Buffer.byteLength(body),
        "Set-Cookie": createSessionCookie(req)
      });
      res.end(body);
      return true;
    }
    return json(res, 401, { message: "用户名或密码不正确" });
  }

  if (req.method === "POST" && url.pathname === "/api/admin/logout") {
    const body = JSON.stringify({ ok: true });
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(body),
      "Set-Cookie": clearSessionCookie(req)
    });
    res.end(body);
    return true;
  }

  if (!requireAdmin(req, res)) return true;

  if (req.method === "GET" && url.pathname === "/api/admin/state") {
    const db = await readDb();
    return json(res, 200, {
      products: db.products.map(adminProduct),
      archives: db.archives.map(adminArchive),
      claims: db.claims
    });
  }

  if (req.method === "POST" && url.pathname === "/api/admin/generate-codes") {
    const body = await readJson(req);
    const count = Number(body.count);
    if (!Number.isInteger(count) || count < 1 || count > 1000) return json(res, 400, { message: "生成数量请输入 1 到 1000 之间的整数" });
    const generated = await mutate(function (db) { return generateUniqueCodes(db, count); });
    return json(res, 200, { codes: generated });
  }

  const productMatch = /^\/api\/admin\/products\/([^/]+)$/.exec(url.pathname);
  const codeMatch = /^\/api\/admin\/products\/([^/]+)\/codes$/.exec(url.pathname);
  const inventoryMatch = /^\/api\/admin\/products\/([^/]+)\/inventory$/.exec(url.pathname);

  if (productMatch && req.method === "PATCH") {
    const id = decodeURIComponent(productMatch[1]);
    const body = await readJson(req);
    const product = await mutate(function (db) {
      const current = productById(db, id);
      if (!current) {
        const created = normalizeProduct({ id: id, title: body.title, subtitle: body.subtitle, category: body.category, codes: [], inventory: [] });
        db.products.push(created);
        return created;
      }
      if (body.title !== undefined) current.title = String(body.title || "").trim();
      if (body.subtitle !== undefined) current.subtitle = String(body.subtitle || "");
      if (body.category !== undefined) current.category = String(body.category || "商品文件");
      return current;
    });
    return json(res, 200, { product: adminProduct(product) });
  }

  if (productMatch && req.method === "PUT") {
    const id = decodeURIComponent(productMatch[1]);
    const body = await readJson(req);
    const product = await mutate(function (db) {
      const current = productById(db, id);
      if (!current) throw new Error("商品池不存在");
      if (body.title !== undefined) current.title = String(body.title || "").trim();
      if (body.subtitle !== undefined) current.subtitle = String(body.subtitle || "");
      if (body.category !== undefined) current.category = String(body.category || "商品文件");
      if (Array.isArray(body.codes)) current.codes = body.codes.map(normalized).filter(Boolean);
      if (Array.isArray(body.inventory)) {
        current.inventory = body.inventory.map(function (item) {
          const existing = current.inventory.find(function (candidate) { return candidate.id === item.id; });
          return existing || normalizeInventory(item);
        });
      }
      return current;
    });
    return json(res, 200, { product: adminProduct(product) });
  }

  if (productMatch && req.method === "DELETE") {
    const id = decodeURIComponent(productMatch[1]);
    await mutate(function (db) {
      db.products = db.products.filter(function (product) { return product.id !== id; });
      Object.keys(db.claims).forEach(function (code) { if (db.claims[code].productId === id) delete db.claims[code]; });
      db.archives = db.archives.filter(function (archive) { return archive.productId !== id; });
    });
    return json(res, 200, { ok: true });
  }

  if (codeMatch && req.method === "POST") {
    const id = decodeURIComponent(codeMatch[1]);
    const body = await readJson(req);
    const codes = Array.isArray(body.codes) ? body.codes.map(normalized).filter(Boolean) : [];
    const product = await mutate(function (db) {
      const target = productById(db, id);
      if (!target) throw new Error("商品池不存在");
      const allCodes = new Set();
      db.products.forEach(function (item) { item.codes.forEach(function (code) { allCodes.add(code); }); });
      db.archives.forEach(function (archive) { allCodes.add(archive.code); });
      if (codes.some(function (code) { return allCodes.has(code); })) throw new Error("其中一个卡密已经存在于卡密池中");
      target.codes = target.codes.concat(Array.from(new Set(codes)));
      return target;
    });
    return json(res, 200, { product: adminProduct(product) });
  }

  if (codeMatch && req.method === "DELETE") {
    const id = decodeURIComponent(codeMatch[1]);
    const body = await readJson(req);
    const codes = Array.isArray(body.codes) ? body.codes.map(normalized).filter(Boolean) : [];
    await mutate(function (db) {
      const product = productById(db, id);
      if (!product) throw new Error("商品池不存在");
      product.codes = product.codes.filter(function (code) { return codes.indexOf(code) === -1; });
      codes.forEach(function (code) { removeClaimAndArchive(db, code); });
    });
    return json(res, 200, { ok: true });
  }

  if (inventoryMatch && req.method === "POST") {
    const id = decodeURIComponent(inventoryMatch[1]);
    const contentType = req.headers["content-type"] || "";
    const parts = parseMultipart(await readBody(req), contentType);
    const files = parts.filter(function (part) { return part.filename; });
    if (!files.length) return json(res, 400, { message: "请选择库存文件" });
    const saved = [];
    for (const file of files) {
      const inventory = normalizeInventory({ id: uid("inventory"), name: safeFileName(file.filename), type: path.extname(file.filename).slice(1, 7).toUpperCase() || "FILE", size: file.data.length, storageName: uid("file") + path.extname(file.filename), downloadToken: token() });
      await fsp.writeFile(path.join(UPLOAD_DIR, inventory.storageName), file.data);
      saved.push(inventory);
    }
    try {
      await mutate(function (db) {
        const product = productById(db, id);
        if (!product) throw new Error("商品池不存在");
        product.inventory = product.inventory.concat(saved);
      });
    } catch (error) {
      await Promise.all(saved.map(function (item) { return fsp.unlink(path.join(UPLOAD_DIR, item.storageName)).catch(function () {}); }));
      throw error;
    }
    return json(res, 200, { inventory: saved.map(publicInventory) });
  }

  if (inventoryMatch && req.method === "DELETE") {
    const id = decodeURIComponent(inventoryMatch[1]);
    const body = await readJson(req);
    const ids = Array.isArray(body.ids) ? body.ids : [];
    await mutate(function (db) {
      const product = productById(db, id);
      if (!product) throw new Error("商品池不存在");
      product.inventory = product.inventory.filter(function (item) { return ids.indexOf(item.id) === -1; });
      removeInventoryRecords(db, id, ids);
    });
    return json(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/admin/archives") {
    const body = await readJson(req);
    const archive = await mutate(function (db) {
      const existingInventory = body.inventory && findInventory(db, body.inventory.id);
      const value = normalizeArchive({
        id: body.id,
        productId: body.productId,
        productTitle: body.productTitle,
        code: body.code,
        inventory: existingInventory || body.inventory,
        claimedAt: body.claimedAt,
        archivedAt: body.archivedAt
      });
      if (!db.archives.some(function (item) { return item.code === value.code; })) db.archives.push(value);
      return value;
    });
    return json(res, 200, { archive: adminArchive(archive) });
  }

  if (req.method === "DELETE" && url.pathname === "/api/admin/archives") {
    const body = await readJson(req);
    const ids = Array.isArray(body.ids) ? body.ids : [];
    await mutate(function (db) {
      const removed = db.archives.filter(function (archive) { return ids.indexOf(archive.id) !== -1; });
      db.archives = db.archives.filter(function (archive) { return ids.indexOf(archive.id) === -1; });
      removed.forEach(function (archive) { delete db.claims[archive.code]; });
    });
    return json(res, 200, { ok: true });
  }

  return false;
}

async function serveFile(res, filePath, contentType) {
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) return text(res, 404, "文件不存在");
    res.writeHead(200, { "Content-Type": contentType, "Content-Length": stat.size, "Cache-Control": "no-store" });
    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    text(res, 404, "文件不存在");
  }
}

async function handleFile(req, res, url) {
  if (req.method !== "GET") return false;
  const match = /^\/api\/files\/([^/]+)$/.exec(url.pathname);
  if (!match) return false;
  const id = decodeURIComponent(match[1]);
  const suppliedToken = url.searchParams.get("token") || "";
  const db = await readDb();
  const item = findInventory(db, id);
  if (!item || !suppliedToken || suppliedToken !== item.downloadToken) return text(res, 403, "无权访问该文件");
  const filePath = item.storageName ? path.join(UPLOAD_DIR, item.storageName) : path.resolve(ROOT, item.sourcePath || "");
  const safeRoot = item.storageName ? UPLOAD_DIR : ROOT;
  if (!filePath.startsWith(path.resolve(safeRoot) + path.sep) && filePath !== path.resolve(safeRoot)) return text(res, 403, "文件路径无效");
  const extension = path.extname(item.name || "").toLowerCase();
  const contentTypes = { ".txt": "text/plain; charset=utf-8", ".pdf": "application/pdf", ".zip": "application/zip", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png" };
  try {
    const stat = await fsp.stat(filePath);
    res.writeHead(200, {
      "Content-Type": contentTypes[extension] || "application/octet-stream",
      "Content-Length": stat.size,
      "Content-Disposition": "attachment; filename*=UTF-8''" + encodeURIComponent(safeFileName(item.name)),
      "Cache-Control": "private, no-store"
    });
    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    text(res, 404, "文件不存在或已被删除");
  }
  return true;
}

async function handleRequest(req, res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/sbdgj/") {
    res.writeHead(302, { "Location": "/sbdgj" });
    res.end();
    return;
  }
  if (url.pathname === "/sbdgj") {
    const page = isAdmin(req) ? "admin.html" : "admin-login.html";
    return serveFile(res, path.join(ROOT, page), "text/html; charset=utf-8");
  }
  if (url.pathname === "/admin.html" && !isAdmin(req)) {
    res.writeHead(302, { "Location": "/admin-login.html" });
    res.end();
    return;
  }
  if (url.pathname.startsWith("/api/public/") && await handlePublic(req, res, url)) return;
  if (url.pathname.startsWith("/api/admin/") && await handleAdmin(req, res, url)) return;
  if (url.pathname.startsWith("/api/files/") && await handleFile(req, res, url)) return;
  if (url.pathname === "/" || url.pathname === "/index.html") return serveFile(res, path.join(ROOT, "index.html"), "text/html; charset=utf-8");
  if (url.pathname === "/admin-login.html") return serveFile(res, path.join(ROOT, "admin-login.html"), "text/html; charset=utf-8");
  if (url.pathname === "/admin.html") return serveFile(res, path.join(ROOT, "admin.html"), "text/html; charset=utf-8");
  if (url.pathname === "/config.js") return serveFile(res, path.join(ROOT, "config.js"), "application/javascript; charset=utf-8");
  return text(res, 404, "页面不存在");
}

async function main() {
  await ensureStorage();
  if (!ADMIN_PASSWORD) {
    console.error("未设置 ADMIN_PASSWORD，配置中心不会启动。请先设置管理员密码。");
  }
  const server = http.createServer(function (req, res) {
    handleRequest(req, res).catch(function (error) {
      console.error(error);
      if (!res.headersSent) json(res, 500, { message: error.message || "服务器内部错误" });
      else res.destroy();
    });
  });
  server.listen(PORT, "0.0.0.0", function () {
    const address = server.address();
    const activePort = address && typeof address === "object" ? address.port : PORT;
    console.log("取件站已启动: http://127.0.0.1:" + activePort);
    console.log("配置中心: http://127.0.0.1:" + activePort + "/admin.html");
  });
}

main().catch(function (error) {
  console.error(error);
  process.exitCode = 1;
});
