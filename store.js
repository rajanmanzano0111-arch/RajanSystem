// BitByte PC Parts - Store system (one file)
// Setup:  npm install express mysql2   then   node store.js   then open http://localhost:3000
// Set your MySQL user and password in the "cfg" block below.
const express = require('express'), mysql = require('mysql2/promise');
const fs = require('fs');
// Lightweight .env loader; existing process environment values take precedence.
if (fs.existsSync('.env')) for (const line of fs.readFileSync('.env','utf8').split(/\r?\n/)) { const m=line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/); if (m && process.env[m[1]]===undefined) process.env[m[1]]=m[2].replace(/^(['"])(.*)\1$/,'$2'); }

const cfg = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'pc_store'
};
const pool = mysql.createPool({ ...cfg, dateStrings: true, decimalNumbers: true, connectionLimit: 10 });

// ---------- DATABASE (server side only - never sent to the browser) ----------
const SCHEMA = `
CREATE TABLE IF NOT EXISTS customers (
  customer_id INT AUTO_INCREMENT PRIMARY KEY,
  first_name VARCHAR(50),
  last_name VARCHAR(50),
  email VARCHAR(100) UNIQUE,
  phone VARCHAR(20),
  address VARCHAR(150)
);

CREATE TABLE IF NOT EXISTS products (
  product_id INT AUTO_INCREMENT PRIMARY KEY,
  product_name VARCHAR(100),
  description VARCHAR(255),
  price DECIMAL(10,2),
  stock_quantity INT,
  low_stock_threshold INT NOT NULL DEFAULT 5
);

CREATE TABLE IF NOT EXISTS employees (
  employee_id INT AUTO_INCREMENT PRIMARY KEY,
  first_name VARCHAR(50),
  last_name VARCHAR(50),
  role VARCHAR(50),
  hire_date DATE
);

CREATE TABLE IF NOT EXISTS orders (
  order_id INT AUTO_INCREMENT PRIMARY KEY,
  customer_id INT,
  employee_id INT,
  order_date DATETIME,
  status VARCHAR(20),
  FOREIGN KEY (customer_id) REFERENCES customers(customer_id),
  FOREIGN KEY (employee_id) REFERENCES employees(employee_id)
);

CREATE TABLE IF NOT EXISTS order_items (
  order_item_id INT AUTO_INCREMENT PRIMARY KEY,
  order_id INT,
  product_id INT,
  quantity INT,
  unit_price DECIMAL(10,2),
  FOREIGN KEY (order_id) REFERENCES orders(order_id),
  FOREIGN KEY (product_id) REFERENCES products(product_id)
);
CREATE TABLE IF NOT EXISTS users (
  user_id INT AUTO_INCREMENT PRIMARY KEY,
  full_name VARCHAR(100) NOT NULL,
  email VARCHAR(120) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('Admin','Manager','Cashier','Inventory Staff') NOT NULL DEFAULT 'Cashier',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS stock_movements (
  movement_id BIGINT AUTO_INCREMENT PRIMARY KEY,
  product_id INT NOT NULL,
  user_id INT NULL,
  movement_type VARCHAR(40) NOT NULL,
  quantity_change INT NOT NULL,
  note VARCHAR(255) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_stock_product_date(product_id, created_at),
  CONSTRAINT fk_stock_product FOREIGN KEY(product_id) REFERENCES products(product_id),
  CONSTRAINT fk_stock_user FOREIGN KEY(user_id) REFERENCES users(user_id) ON DELETE SET NULL
);
`;

// Starter data: products and employees only. Customers and orders are added from the app.
const SEED = `
INSERT INTO products (product_name, description, price, stock_quantity) VALUES
('Ryzen 5 7600 Processor', '6-core AM5 CPU, 3.8 GHz base', 11990.00, 14),
('Intel Core i5-14400F', '10-core LGA1700 CPU, no integrated graphics', 10450.00, 9),
('ASUS TUF B650-Plus WiFi', 'AM5 ATX motherboard, DDR5', 13500.00, 6),
('Corsair Vengeance 16GB DDR5-6000', '2x8GB memory kit', 3890.00, 25),
('Samsung 980 Pro 1TB NVMe', 'PCIe 4.0 M.2 SSD', 5990.00, 18),
('RTX 4060 8GB Dual', 'Gaming graphics card, 8GB GDDR6', 18900.00, 4),
('Radeon RX 7800 XT 16GB', 'Gaming graphics card, 16GB GDDR6', 32500.00, 3),
('Corsair RM750e 750W', '80+ Gold fully modular power supply', 6490.00, 11),
('NZXT H5 Flow Case', 'ATX mid-tower case, mesh front', 5200.00, 8),
('Deepcool AK400 Cooler', 'Single-tower CPU air cooler', 1650.00, 30);

INSERT INTO employees (first_name, last_name, role, hire_date) VALUES
('Carlo', 'Mendoza', 'Store Manager', '2022-03-01'),
('Liza', 'Garcia', 'Sales Associate', '2023-07-15'),
('Ben', 'Torres', 'Technician', '2024-01-10');
`;

async function setup() {
  const c = await mysql.createConnection({ ...cfg, database: undefined, multipleStatements: true });
  try { await c.query('CREATE DATABASE IF NOT EXISTS `' + cfg.database + '`'); }
  catch (e) { if (e.code !== 'ER_DBACCESS_DENIED_ERROR' && e.code !== 'ER_ACCESS_DENIED_ERROR') throw e; }
  await c.query('USE `' + cfg.database + '`');
  await c.query(SCHEMA);
  // Backward-compatible migration for databases created before the threshold column existed.
  const [[thresholdCol]] = await c.query("SELECT COUNT(*) n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME='products' AND COLUMN_NAME='low_stock_threshold'", [cfg.database]);
  if (!thresholdCol.n) await c.query('ALTER TABLE products ADD COLUMN low_stock_threshold INT NOT NULL DEFAULT 5');
  const [[p]] = await c.query('SELECT COUNT(*) n FROM products');
  const [[e]] = await c.query('SELECT COUNT(*) n FROM employees');
  if (!p.n && !e.n) await c.query(SEED);
  const adminEmail = process.env.BOOTSTRAP_ADMIN_EMAIL;
  const adminPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (adminEmail && adminPassword) {
    if (adminPassword.length < 12) throw new Error('BOOTSTRAP_ADMIN_PASSWORD must be at least 12 characters.');
    const [existing] = await c.query('SELECT user_id FROM users WHERE email=?', [adminEmail.toLowerCase()]);
    if (!existing.length) {
      const hash = await hashPassword(adminPassword);
      await c.query('INSERT INTO users(full_name,email,password_hash,role) VALUES(?,?,?,?)', ['System Administrator', adminEmail.toLowerCase(), hash, 'Admin']);
      console.log('Initial administrator account created from environment variables.');
    }
  }
  const [[userCount]]=await c.query('SELECT COUNT(*) n FROM users');
  if (!userCount.n) throw new Error('No administrator exists. Set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD in .env, then restart.');
  await c.end();
}

// ---------- SERVER ----------
const app = express();
app.disable('x-powered-by');
app.use((req,res,next)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','same-origin');next()});
app.use(express.json({ limit: '100kb' }));
app.get('/', (req, res) => res.type('html').send(HTML));

const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const sessions = new Map(); // In-memory sessions: restarting the server signs everyone out.
const loginAttempts = new Map();
const SESSION_TTL = 8 * 60 * 60 * 1000;
const hashPassword = async password => {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt}$${key.toString('hex')}`;
};
const verifyPassword = async (password, stored) => {
  try {
    const [kind, salt, hex] = stored.split('$');
    if (kind !== 'scrypt' || !salt || !hex) return false;
    const actual = await scrypt(password, salt, 64);
    const expected = Buffer.from(hex, 'hex');
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch { return false; }
};
const sign = value => crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('hex');
const cookieToken = req => (req.headers.cookie || '').split(';').map(x=>x.trim()).find(x=>x.startsWith('bb_session='))?.slice(11) || '';
const safeUser = u => ({ user_id:u.user_id, full_name:u.full_name, email:u.email, role:u.role });
const requireAuth = async (req,res,next) => {
  try {
    const token = cookieToken(req);
    const [sid, mac] = token.split('.');
    const expected=SESSION_SECRET?sign(sid||''):'';
    if (!sid || !mac || mac.length!==expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return res.status(401).json({error:'Please sign in.'});
    const session = sessions.get(sid);
    if (!session || session.expires < Date.now()) { sessions.delete(sid); return res.status(401).json({error:'Session expired. Please sign in again.'}); }
    const [[user]]=await pool.query('SELECT user_id,full_name,email,role,is_active FROM users WHERE user_id=?',[session.user.user_id]);
    if (!user || !user.is_active) { sessions.delete(sid); return res.status(401).json({error:'Your account is disabled. Contact an administrator.'}); }
    req.user = safeUser(user); session.user=req.user; session.expires = Date.now() + SESSION_TTL; next();
  } catch(e) { next(e); }
};
const allowRoles = (...roles) => (req,res,next) => roles.includes(req.user.role) ? next() : res.status(403).json({error:'You do not have permission to perform this action.'});
app.get('/api/auth/me', (req,res) => {
  const token=cookieToken(req), [sid,mac]=token.split('.');
  if (!sid || !mac || !SESSION_SECRET || mac !== sign(sid)) return res.json({user:null});
  const x=sessions.get(sid); if (!x || x.expires<Date.now()) { sessions.delete(sid); return res.json({user:null}); }
  res.json({user:x.user});
});
app.post('/api/auth/login', async (req,res) => {
  try {
    const email=String(req.body?.email||'').trim().toLowerCase(), password=String(req.body?.password||'');
    const ip=req.ip || req.socket.remoteAddress || 'unknown';
    const attempt=loginAttempts.get(ip) || {count:0,until:0};
    if (attempt.until>Date.now() && attempt.count>=8) return res.status(429).json({error:'Too many login attempts. Try again later.'});
    const [rows]=await pool.query('SELECT * FROM users WHERE email=? AND is_active=1 LIMIT 1',[email]);
    const valid=rows.length && await verifyPassword(password,rows[0].password_hash);
    if (!valid) { attempt.count++; attempt.until=Date.now()+15*60*1000; loginAttempts.set(ip,attempt); return res.status(401).json({error:'Invalid email or password.'}); }
    loginAttempts.delete(ip);
    const sid=crypto.randomBytes(32).toString('hex');
    const user=safeUser(rows[0]); sessions.set(sid,{user,expires:Date.now()+SESSION_TTL});
    res.setHeader('Set-Cookie',`bb_session=${sid}.${sign(sid)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL/1000}`);
    res.json({user});
  } catch(e) { res.status(500).json({error:'Unable to sign in.'}); }
});
app.post('/api/auth/logout', (req,res) => {
  const [sid]=cookieToken(req).split('.'); if (sid) sessions.delete(sid);
  res.setHeader('Set-Cookie','bb_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); res.json({ok:true});
});

const fail = (m, status = 400) => Object.assign(new Error(m), { status });
const positiveInt = v => Number.isSafeInteger(Number(v)) && Number(v) > 0;
const validId = v => positiveInt(v);
const validText = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.trim().length <= max;
const validMoney = v => Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 99999999.99;
const validQuantity = v => positiveInt(v) && Number(v) <= 2147483647;
const ORDER_TRANSITIONS = {
  Pending: ['Paid', 'Cancelled'],
  Paid: ['Shipped', 'Cancelled'],
  Shipped: ['Completed'],
  Completed: [],
  Cancelled: []
};
const wrap = f => async (req, res) => {
  try { await f(req, res); }
  catch (e) {
    const msg = e.code === 'ER_DUP_ENTRY' ? 'That email address or unique value is already in use.'
      : e.code === 'ER_ROW_IS_REFERENCED_2' ? 'Cannot delete: used by existing orders' : e.message;
    const status=e.code === 'ER_DUP_ENTRY' ? 409 : e.status || 500;
    res.status(status).json({ error: status>=500 ? 'A server error occurred. Check the server log.' : msg });
    if(status>=500) console.error(e);
  }
};
const tx = async fn => {
  const c = await pool.getConnection();
  try { await c.beginTransaction(); await fn(c); await c.commit(); }
  catch (e) { await c.rollback(); throw e; }
  finally { c.release(); }
};
const logStock = async (c, productId, userId, type, change, note) => {
  if (change) await c.query('INSERT INTO stock_movements(product_id,user_id,movement_type,quantity_change,note) VALUES(?,?,?,?,?)',[productId,userId||null,type,change,note||null]);
};
const restore = async (c, id, userId) => {
  const [[o]] = await c.query('SELECT status FROM orders WHERE order_id=? FOR UPDATE', [id]);
  if (o && o.status !== 'Cancelled') {
    const [items]=await c.query('SELECT product_id,SUM(quantity) quantity FROM order_items WHERE order_id=? GROUP BY product_id',[id]);
    for (const item of items) { await c.query('UPDATE products SET stock_quantity=stock_quantity+? WHERE product_id=?',[item.quantity,item.product_id]); await logStock(c,item.product_id,userId,'ORDER_RESTOCK',item.quantity,`Order #${id} cancelled/deleted`); }
  }
};

app.use('/api', (req,res,next) => {
  if (req.path.startsWith('/auth/')) return next();
  if (!['GET','HEAD','OPTIONS'].includes(req.method) && req.headers.origin) {
    try { if (new URL(req.headers.origin).host !== req.headers.host) return res.status(403).json({error:'Request origin rejected.'}); }
    catch { return res.status(403).json({error:'Request origin rejected.'}); }
  }
  return requireAuth(req,res,next);
});

app.get('/api/all', wrap(async (q, r) => {
  const out = {customers:[],products:[],employees:[],orders:[],order_items:[]};
  out.products=(await pool.query('SELECT * FROM products'))[0];
  if (['Admin','Manager','Cashier'].includes(q.user.role)) {
    out.customers=(await pool.query('SELECT * FROM customers'))[0];
    out.orders=(await pool.query('SELECT * FROM orders'))[0];
    out.order_items=(await pool.query('SELECT * FROM order_items'))[0];
  }
  if (['Admin','Manager','Cashier'].includes(q.user.role)) out.employees=(await pool.query('SELECT * FROM employees'))[0];
  r.json(out);
}));
app.get('/api/low-stock', wrap(async (q,r) => {
  const [rows]=await pool.query('SELECT product_id,product_name,stock_quantity,low_stock_threshold FROM products WHERE stock_quantity<=low_stock_threshold ORDER BY stock_quantity ASC');
  r.json(rows);
}));
app.get('/api/stock-movements', allowRoles('Admin','Manager','Inventory Staff'), wrap(async (q,r) => {
  const [rows]=await pool.query(`SELECT sm.*,p.product_name,u.full_name FROM stock_movements sm JOIN products p ON p.product_id=sm.product_id LEFT JOIN users u ON u.user_id=sm.user_id ORDER BY sm.created_at DESC LIMIT 300`);
  r.json(rows);
}));
app.get('/api/users', allowRoles('Admin'), wrap(async (q,r) => {
  const [rows]=await pool.query('SELECT user_id,full_name,email,role,is_active,created_at FROM users ORDER BY user_id'); r.json(rows);
}));
app.post('/api/users', allowRoles('Admin'), wrap(async (q,r) => {
  const {full_name,email,password,role}=q.body||{};
  if (!validText(full_name,100) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email||'')) || String(email).length>120) throw fail('Enter a valid name and email.');
  if (typeof password!=='string' || password.length<12 || password.length>200) throw fail('Password must be at least 12 characters.');
  if (!['Admin','Manager','Cashier','Inventory Staff'].includes(role)) throw fail('Invalid role.');
  const hash=await hashPassword(password);
  await pool.query('INSERT INTO users(full_name,email,password_hash,role) VALUES(?,?,?,?)',[full_name.trim(),email.toLowerCase(),hash,role]); r.json({ok:true});
}));
app.put('/api/users/:id', allowRoles('Admin'), wrap(async (q,r) => {
  if (!validId(q.params.id)) throw fail('Invalid user ID.');
  const {role,is_active,password}=q.body||{};
  if (role!==undefined && !['Admin','Manager','Cashier','Inventory Staff'].includes(role)) throw fail('Invalid role.');
  if (is_active!==undefined && ![true,false,0,1].includes(is_active)) throw fail('Invalid active state.');
  if (Number(q.params.id)===q.user.user_id && is_active!==undefined && Number(is_active)===0) throw fail('You cannot deactivate your own account.');
  if (password!==undefined && (typeof password!=='string'||password.length<12||password.length>200)) throw fail('New password must be at least 12 characters.');
  if (password!==undefined) await pool.query('UPDATE users SET password_hash=? WHERE user_id=?',[await hashPassword(password),q.params.id]);
  if (role!==undefined || is_active!==undefined) await pool.query('UPDATE users SET role=COALESCE(?,role),is_active=COALESCE(?,is_active) WHERE user_id=?',[role??null,is_active===undefined?null:Number(is_active),q.params.id]);
  r.json({ok:true});
}));

// ---- Orders ----
app.post('/api/orders', allowRoles('Admin','Manager','Cashier'), wrap(async (req, res) => {
  const { customer_id, employee_id, items } = req.body;
  if (!validId(customer_id) || !validId(employee_id)) throw fail('Select a valid customer and employee.');
  if (!Array.isArray(items) || !items.length || items.length > 100) throw fail('Add between 1 and 100 order items.');
  for (const i of items) {
    if (!validId(i.product_id) || !validQuantity(i.quantity)) throw fail('Each item needs a valid product and whole-number quantity.');
  }
  let id;
  await tx(async c => {
    const [[customer]]=await c.query('SELECT customer_id FROM customers WHERE customer_id=?',[customer_id]);
    const [[employee]]=await c.query('SELECT employee_id FROM employees WHERE employee_id=?',[employee_id]);
    if (!customer) throw fail('Customer not found.',404);
    if (!employee) throw fail('Employee not found.',404);
    const [o] = await c.query('INSERT INTO orders (customer_id, employee_id, order_date, status) VALUES (?,?,NOW(),?)', [customer_id, employee_id, 'Pending']);
    id = o.insertId;
    for (const i of items) {
      const [[p]] = await c.query('SELECT * FROM products WHERE product_id=? FOR UPDATE', [i.product_id]);
      if (!p) throw fail('Product not found.', 404);
      if (p.stock_quantity < i.quantity) throw fail(`Only ${p.stock_quantity} of ${p.product_name} in stock.`);
      await c.query('UPDATE products SET stock_quantity = stock_quantity - ? WHERE product_id=?', [i.quantity, p.product_id]);
      await logStock(c,p.product_id,req.user.user_id,'ORDER_RESERVED',-i.quantity,`Order #${id} created`);
      await c.query('INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES (?,?,?,?)', [id, p.product_id, i.quantity, p.price]);
    }
  });
  res.json({ order_id: id });
}));
app.put('/api/orders/:id', allowRoles('Admin','Manager'), wrap(async (req, res) => {
  const s = req.body.status;
  if (!['Pending', 'Paid', 'Shipped', 'Completed', 'Cancelled'].includes(s)) throw fail('Invalid status.');
  if (!validId(req.params.id)) throw fail('Invalid order ID.');
  await tx(async c => {
    const [[o]] = await c.query('SELECT status FROM orders WHERE order_id=? FOR UPDATE', [req.params.id]);
    if (!o) throw fail('Order not found.', 404);
    if (s === o.status) return;
    if (!ORDER_TRANSITIONS[o.status]?.includes(s))
      throw fail(`Cannot change order status from ${o.status} to ${s}.`);
    if (s === 'Cancelled') await restore(c, req.params.id, req.user.user_id);
    await c.query('UPDATE orders SET status=? WHERE order_id=?', [s, req.params.id]);
  });
  res.json({ ok: true });
}));
app.delete('/api/orders/:id', allowRoles('Admin','Manager'), wrap(async (req, res) => {
  if (!validId(req.params.id)) throw fail('Invalid order ID.');
  await tx(async c => {
    const [[o]] = await c.query('SELECT status FROM orders WHERE order_id=? FOR UPDATE', [req.params.id]);
    if (!o) throw fail('Order not found.', 404);
    if (!['Pending', 'Cancelled'].includes(o.status))
      throw fail('Only Pending or Cancelled orders can be deleted. Keep paid, shipped, and completed orders for sales history.');
    await restore(c, req.params.id, req.user.user_id);
    await c.query('DELETE FROM order_items WHERE order_id=?', [req.params.id]);
    await c.query('DELETE FROM orders WHERE order_id=?', [req.params.id]);
  });
  res.json({ ok: true });
}));

// ---- Order items ----
app.post('/api/order-items', allowRoles('Admin','Manager','Cashier'), wrap(async (req, res) => {
  const { order_id, product_id, quantity } = req.body;
  if (!validId(order_id) || !validId(product_id) || !validQuantity(quantity)) throw fail('Order, product, and quantity must be valid whole numbers.');
  await tx(async c => {
    const [[o]] = await c.query('SELECT status FROM orders WHERE order_id=? FOR UPDATE', [order_id]);
    if (!o) throw fail('Order not found.');
    if (o.status !== 'Pending') throw fail('Items can only be changed while an order is Pending.');
    const [[p]] = await c.query('SELECT * FROM products WHERE product_id=? FOR UPDATE', [product_id]);
    if (!p) throw fail('Product not found.');
    if (p.stock_quantity < quantity) throw fail(`Only ${p.stock_quantity} of ${p.product_name} in stock.`);
    await c.query('UPDATE products SET stock_quantity = stock_quantity - ? WHERE product_id=?', [quantity, product_id]);
    await logStock(c,product_id,req.user.user_id,'ORDER_ITEM_ADDED',-quantity,`Added to order #${order_id}`);
    await c.query('INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES (?,?,?,?)', [order_id, product_id, quantity, p.price]);
  });
  res.json({ ok: true });
}));
app.put('/api/order-items/:id', allowRoles('Admin','Manager'), wrap(async (req, res) => {
  if (!validId(req.params.id)) throw fail('Invalid order item ID.');
  const quantity = req.body.quantity;
  if (!validQuantity(quantity)) throw fail('Quantity must be a positive whole number.');
  await tx(async c => {
    const [[i]] = await c.query('SELECT * FROM order_items WHERE order_item_id=? FOR UPDATE', [req.params.id]);
    if (!i) throw fail('Item not found.', 404);
    const [[o]] = await c.query('SELECT status FROM orders WHERE order_id=? FOR UPDATE', [i.order_id]);
    if (!o || o.status !== 'Pending') throw fail('Items can only be changed while an order is Pending.');
    const diff = quantity - i.quantity;
    if (diff) {
      const [[p]] = await c.query('SELECT * FROM products WHERE product_id=? FOR UPDATE', [i.product_id]);
      if (diff > p.stock_quantity) throw fail(`Only ${p.stock_quantity} more of ${p.product_name} in stock.`);
      await c.query('UPDATE products SET stock_quantity = stock_quantity - ? WHERE product_id=?', [diff, i.product_id]);
      await logStock(c,i.product_id,req.user.user_id,'ORDER_ITEM_ADJUSTED',-diff,`Quantity adjusted on order #${i.order_id}`);
    }
    await c.query('UPDATE order_items SET quantity=? WHERE order_item_id=?', [quantity, i.order_item_id]);
  });
  res.json({ ok: true });
}));
app.delete('/api/order-items/:id', allowRoles('Admin','Manager'), wrap(async (req, res) => {
  if (!validId(req.params.id)) throw fail('Invalid order item ID.');
  await tx(async c => {
    const [[i]] = await c.query('SELECT * FROM order_items WHERE order_item_id=? FOR UPDATE', [req.params.id]);
    if (!i) throw fail('Item not found.', 404);
    const [[o]] = await c.query('SELECT status FROM orders WHERE order_id=? FOR UPDATE', [i.order_id]);
    if (!o || o.status !== 'Pending') throw fail('Items can only be removed while an order is Pending.');
    await c.query('UPDATE products SET stock_quantity = stock_quantity + ? WHERE product_id=?', [i.quantity, i.product_id]);
    await logStock(c,i.product_id,req.user.user_id,'ORDER_ITEM_REMOVED',i.quantity,`Removed from order #${i.order_id}`);
    await c.query('DELETE FROM order_items WHERE order_item_id=?', [i.order_item_id]);
  });
  res.json({ ok: true });
}));

// ---- Products, customers, employees ----
const T = {
  products: ['product_id', ['product_name', 'description', 'price', 'stock_quantity', 'low_stock_threshold']],
  customers: ['customer_id', ['first_name', 'last_name', 'email', 'phone', 'address']],
  employees: ['employee_id', ['first_name', 'last_name', 'role', 'hire_date']]
};
const tbl = req => T[req.params.t] || (() => { throw fail('Unknown table', 404); })();
function validateEntity(t, body) {
  const required = {
    products: ['product_name', 'price', 'stock_quantity'],
    customers: ['first_name', 'last_name', 'email'],
    employees: ['first_name', 'last_name', 'role']
  }[t];
  if (!required) throw fail('Unknown table.', 404);
  for (const k of required) if (body[k] === undefined || body[k] === null || body[k] === '')
    throw fail(`${k.replaceAll('_', ' ')} is required.`);
  if (t === 'products') {
    if (!validText(body.product_name, 100)) throw fail('Product name must be 1–100 characters.');
    if (body.description != null && String(body.description).length > 255) throw fail('Description is too long.');
    if (!validMoney(body.price)) throw fail('Price must be a non-negative valid amount.');
    if (!Number.isSafeInteger(Number(body.stock_quantity)) || Number(body.stock_quantity) < 0) throw fail('Stock quantity must be a non-negative whole number.');
    if (body.low_stock_threshold===undefined || !Number.isSafeInteger(Number(body.low_stock_threshold)) || Number(body.low_stock_threshold)<0) throw fail('Low-stock threshold must be a non-negative whole number.');
  }
  if (t === 'customers') {
    for (const k of ['first_name', 'last_name']) if (!validText(body[k], 50)) throw fail(`${k.replaceAll('_', ' ')} must be 1–50 characters.`);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(body.email)) || String(body.email).length > 100) throw fail('Enter a valid email address.');
    if (body.phone != null && String(body.phone).length > 20) throw fail('Phone number is too long.');
    if (body.address != null && String(body.address).length > 150) throw fail('Address is too long.');
  }
  if (t === 'employees') {
    for (const k of ['first_name', 'last_name', 'role']) if (!validText(body[k], 50)) throw fail(`${k.replaceAll('_', ' ')} must be 1–50 characters.`);
  }
}
const entityRoles = { products:['Admin','Manager','Inventory Staff'], customers:['Admin','Manager','Cashier'], employees:['Admin'] };
app.post('/api/:t', (req,res,next)=>allowRoles(...(entityRoles[req.params.t]||[]))(req,res,next), wrap(async (req, res) => {
  const [, f] = tbl(req); validateEntity(req.params.t, req.body || {});
  const [result]=await pool.query(`INSERT INTO ${req.params.t} (${f.join(',')}) VALUES (${f.map(() => '?').join(',')})`, f.map(k => req.body[k] ?? null));
  if (req.params.t==='products') { const qty=Number(req.body.stock_quantity); await pool.query('INSERT INTO stock_movements(product_id,user_id,movement_type,quantity_change,note) VALUES(?,?,?,?,?)',[result.insertId,req.user.user_id,'INITIAL_STOCK',qty,'Product created']); }
  res.json({ ok: true });
}));
app.put('/api/:t/:id', (req,res,next)=>allowRoles(...(entityRoles[req.params.t]||[]))(req,res,next), wrap(async (req, res) => {
  const [pk, f] = tbl(req); validateEntity(req.params.t, req.body || {});
  if (!validId(req.params.id)) throw fail('Invalid record ID.');
  if (req.params.t==='products') {
    await tx(async c=>{
      const [[old]]=await c.query('SELECT stock_quantity FROM products WHERE product_id=? FOR UPDATE',[req.params.id]);
      if (!old) throw fail('Record not found.',404);
      const [result]=await c.query(`UPDATE products SET ${f.map(k => k + '=?').join(',')} WHERE ${pk}=?`, [...f.map(k => req.body[k] ?? null), req.params.id]);
      const delta=Number(req.body.stock_quantity)-Number(old.stock_quantity);
      await logStock(c,Number(req.params.id),req.user.user_id,'MANUAL_ADJUSTMENT',delta,'Product stock edited');
    });
  } else {
    const [result] = await pool.query(`UPDATE ${req.params.t} SET ${f.map(k => k + '=?').join(',')} WHERE ${pk}=?`, [...f.map(k => req.body[k] ?? null), req.params.id]);
    if (!result.affectedRows) throw fail('Record not found.', 404);
  }
  res.json({ ok: true });
}));
app.delete('/api/:t/:id', (req,res,next)=>allowRoles(...(entityRoles[req.params.t]||[]))(req,res,next), wrap(async (req, res) => {
  const [pk] = tbl(req); if (!validId(req.params.id)) throw fail('Invalid record ID.');
  if (req.params.t==='products') {
    const [[used]]=await pool.query('SELECT (SELECT COUNT(*) FROM order_items WHERE product_id=?) + (SELECT COUNT(*) FROM stock_movements WHERE product_id=?) n',[req.params.id,req.params.id]);
    if (used.n) throw fail('This product has sales or inventory history. Keep the record and set its stock to zero instead.',409);
  }
  if (req.params.t==='customers' || req.params.t==='employees') {
    const fk=req.params.t==='customers'?'customer_id':'employee_id';
    const [[used]]=await pool.query(`SELECT COUNT(*) n FROM orders WHERE ${fk}=?`,[req.params.id]);
    if (used.n) throw fail('This record is linked to order history and cannot be deleted.',409);
  }
  await pool.query(`DELETE FROM ${req.params.t} WHERE ${pk}=?`, [req.params.id]);
  res.json({ ok: true });
}));


// ---------- SCREEN (HTML page) ----------
const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>BitByte PC Parts – Store Manager</title>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px);
--bg:#eef1f4;--card:#fff;--text:#14181d;--muted:#657080;--line:#d9dfe6;--accent:#1f5eff;--accent-t:#fff;--ok:#12805c;--warn:#b45309;--bad:#c42b2b;--side:#14181d;--side-t:#cfd6df}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0e1217;--card:#171d25;--text:#e8ecf1;--muted:#8f9bab;--line:#2a323d;--accent:#5b8cff;--accent-t:#0e1217;--ok:#3fcf9b;--warn:#f0a346;--bad:#ff7a7a;--side:#0a0d11;--side-t:#aab4c1}}
:root[data-theme="dark"]{--bg:#0e1217;--card:#171d25;--text:#e8ecf1;--muted:#8f9bab;--line:#2a323d;--accent:#5b8cff;--accent-t:#0e1217;--ok:#3fcf9b;--warn:#f0a346;--bad:#ff7a7a;--side:#0a0d11;--side-t:#aab4c1}
html{scroll-padding-top:env(safe-area-inset-top,0px)}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 "IBM Plex Sans",system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;min-height:100vh}
nav{width:210px;background:var(--side);color:var(--side-t);padding:20px 12px;flex-shrink:0;position:sticky;top:0;height:100vh;align-self:flex-start}
nav h1{font-size:17px;color:#fff;margin:0 8px 2px;font-weight:600}
nav small{display:block;margin:0 8px 18px;font-size:12px;opacity:.7}
nav button{display:block;width:100%;text-align:left;background:none;border:0;color:inherit;font:inherit;padding:9px 10px;border-radius:6px;cursor:pointer}
nav button:hover{background:rgba(255,255,255,.07)}
nav button.on{background:var(--accent);color:var(--accent-t);font-weight:500}
main{flex:1;min-width:0;padding:24px 28px 48px}
h2{margin:0;font-size:22px;font-weight:600}
.bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:0 0 16px}
.bar .sp{flex:1}
input,select,button.b{font:inherit;color:var(--text);background:var(--card);border:1px solid var(--line);border-radius:6px;padding:8px 10px}
input:focus,select:focus,button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
button.b{cursor:pointer}
button.p{background:var(--accent);color:var(--accent-t);border-color:var(--accent);font-weight:500}
button.d{color:var(--bad)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:18px}
.st{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px}
.st b{display:block;font-size:24px;font-weight:600}.st span{color:var(--muted);font-size:13px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.box{background:var(--card);border:1px solid var(--line);border-radius:8px;overflow-x:auto}
.box h3{margin:0;padding:12px 14px;font-size:15px;border-bottom:1px solid var(--line)}
table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:9px 14px;border-bottom:1px solid var(--line);white-space:nowrap}
th{font-weight:500;color:var(--muted);font-size:13px}
tr:last-child td{border-bottom:0}
td.r,th.r{text-align:right}
td.act{text-align:right}td.act button{margin-left:6px;padding:4px 9px;font-size:13px}
.tag{display:inline-block;padding:1px 9px;border-radius:99px;font-size:12.5px;border:1px solid currentColor}
.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}.mut{color:var(--muted)}
.empty{padding:28px;text-align:center;color:var(--muted)}
dialog{border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--text);padding:0;width:min(560px,94vw);max-height:90vh}
dialog::backdrop{background:rgba(0,0,0,.5)}
.dh{padding:14px 18px;border-bottom:1px solid var(--line);font-weight:600}
.db{padding:16px 18px;display:grid;gap:12px;overflow-y:auto;max-height:65vh}
.df{padding:12px 18px;border-top:1px solid var(--line);display:flex;gap:8px;justify-content:flex-end}
label{display:grid;gap:4px;font-size:13px;color:var(--muted)}label input,label select{color:var(--text);font-size:15px;width:100%}
.irow{display:grid;grid-template-columns:1fr 80px 34px;gap:8px}
.err{color:var(--bad);font-size:14px;min-height:1em}
#toast{position:fixed;bottom:calc(18px + env(safe-area-inset-bottom,0px));right:18px;background:var(--text);color:var(--bg);padding:10px 14px;border-radius:6px;opacity:0;transition:opacity .2s;pointer-events:none}
#toast.s{opacity:1}
pre{margin:0;padding:14px;font:12.5px/1.5 ui-monospace,Menlo,Consolas,monospace;overflow-x:auto}
@media(max-width:760px){body{flex-direction:column}nav{width:100%;height:auto;position:static;display:flex;flex-wrap:wrap;gap:4px;padding:10px}nav h1,nav small{display:none}nav button{width:auto}main{padding:16px 14px 40px}.grid2{grid-template-columns:1fr}}
</style>
</head>
<body>
<nav>
<h1>BitByte PC Parts</h1><small>Store manager</small>
<div id="menu"></div>
</nav>
<main id="view"></main>
<dialog id="dlg"></dialog>
<div id="toast"></div>
<script>
const $=s=>document.querySelector(s);
const peso=n=>'₱'+Number(n).toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2});
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
let DB={customers:[],products:[],employees:[],orders:[],order_items:[]}, CURRENT_USER=null;
async function api(m,p,b){const r=await fetch('/api'+p,{method:m,credentials:'same-origin',headers:{'Content-Type':'application/json'},body:b?JSON.stringify(b):undefined});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||'Request failed');return j}
const reload=async()=>{DB=await api('GET','/all')};
const find=(t,k,v)=>DB[t].find(r=>r[k]==v);
const cname=id=>{const c=find('customers','customer_id',id);return c?c.first_name+' '+c.last_name:'—'};
const ename=id=>{const e=find('employees','employee_id',id);return e?e.first_name+' '+e.last_name:'—'};
const ototal=id=>DB.order_items.filter(i=>i.order_id==id).reduce((s,i)=>s+i.quantity*i.unit_price,0);
function toast(m){const t=$('#toast');t.textContent=m;t.classList.add('s');clearTimeout(toast.t);toast.t=setTimeout(()=>t.classList.remove('s'),2200)}
const STATUS=['Pending','Paid','Shipped','Completed','Cancelled'];
const scls=s=>({Completed:'ok',Paid:'ok',Shipped:'ok',Pending:'warn',Cancelled:'bad'}[s]);

const E={
 products:{pk:'product_id',title:'Products',f:[['product_name','Product name','text'],['description','Description','text'],['price','Price (₱)','number'],['stock_quantity','Stock quantity','number'],['low_stock_threshold','Low-stock threshold','number']]},
 customers:{pk:'customer_id',title:'Customers',f:[['first_name','First name','text'],['last_name','Last name','text'],['email','Email','email'],['phone','Phone','text'],['address','Address','text']]},
 employees:{pk:'employee_id',title:'Employees',f:[['first_name','First name','text'],['last_name','Last name','text'],['role','Role','text'],['hire_date','Hire date','date']]}
};
const refs={products:['order_items','product_id'],customers:['orders','customer_id'],employees:['orders','employee_id']};
let tab='dashboard',q='';
const TABS=[['dashboard','Dashboard'],['orders','Orders'],['order_items','Order items'],['products','Products'],['customers','Customers'],['employees','Employees'],['stock','Stock history'],['reports','Sales reports'],['users','User accounts']];
function visibleTabs(){return TABS.filter(t=>t[0]!=='employees'||['Admin','Manager'].includes(CURRENT_USER?.role)).filter(t=>t[0]!=='stock'||['Admin','Manager','Inventory Staff'].includes(CURRENT_USER?.role)).filter(t=>t[0]!=='users'||CURRENT_USER?.role==='Admin').filter(t=>t[0]!=='reports'||['Admin','Manager'].includes(CURRENT_USER?.role)).filter(t=>t[0]!=='orders'||CURRENT_USER?.role!=='Inventory Staff').filter(t=>t[0]!=='customers'||CURRENT_USER?.role!=='Inventory Staff').filter(t=>t[0]!=='order_items'||CURRENT_USER?.role!=='Inventory Staff');}
function menu(){$('#menu').innerHTML=visibleTabs().map(t=>\`<button class="\${t[0]==tab?'on':''}" data-t="\${t[0]}">\${t[1]}</button>\`).join('')+\`<button id="logout">Sign out · \${esc(CURRENT_USER?.full_name||'')}</button>\`;}
$('#menu').onclick=async e=>{if(e.target.id==='logout'){await api('POST','/auth/logout');CURRENT_USER=null;showLogin();return}const t=e.target.dataset.t;if(t){tab=t;q='';render()}};
function render(){menu();if(tab==='stock')return stockHistory();if(tab==='reports')return salesReports();if(tab==='users')return usersPage();({dashboard,orders,order_items:orderItems}[tab]||(()=>entity(tab)))();}

function dashboard(){
 const recognized=DB.orders.filter(o=>['Paid','Shipped','Completed'].includes(o.status));
 const rev=recognized.reduce((s,o)=>s+ototal(o.order_id),0);
 const pending=DB.orders.filter(o=>o.status==='Pending');
 const pendingValue=pending.reduce((s,o)=>s+ototal(o.order_id),0);
 const low=DB.products.filter(p=>p.stock_quantity<=Number(p.low_stock_threshold??5)).sort((a,b)=>a.stock_quantity-b.stock_quantity);
 const rec=[...DB.orders].sort((a,b)=>b.order_date.localeCompare(a.order_date)).slice(0,5);
 $('#view').innerHTML=\`<div class="bar"><h2>Dashboard</h2></div>
 <div class="stats"><div class="st"><b>\${peso(rev)}</b><span>Order sales total (Paid / Shipped / Completed; not payment reconciliation)</span></div><div class="st"><b>\${DB.orders.filter(o=>o.status=='Pending').length}</b><span>Pending orders · \${peso(pendingValue)}</span></div><div class="st"><b>\${low.length}</b><span>Low-stock products</span></div><div class="st"><b>\${DB.customers.length}</b><span>Customers</span></div></div>
 <div class="grid2"><div class="box"><h3>Recent orders</h3><table>\${rec.map(o=>\`<tr><td>#\${o.order_id}</td><td>\${esc(cname(o.customer_id))}</td><td><span class="tag \${scls(o.status)}">\${o.status}</span></td><td class="r">\${peso(ototal(o.order_id))}</td></tr>\`).join('')||'<tr><td class="empty">No orders yet.</td></tr>'}</table></div>
 <div class="box"><h3>Low stock (at/below product threshold)</h3><table>\${low.map(p=>\`<tr><td>\${esc(p.product_name)}</td><td class="r"><span class="tag \${p.stock_quantity?'warn':'bad'}">\${p.stock_quantity} left</span></td></tr>\`).join('')||'<tr><td class="empty">All products are well stocked.</td></tr>'}</table></div></div>\`;
}

function entity(t){
 const c=E[t],canWrite=(t==='products'&&['Admin','Manager','Inventory Staff'].includes(CURRENT_USER.role))||(t==='customers'&&['Admin','Manager','Cashier'].includes(CURRENT_USER.role))||(t==='employees'&&CURRENT_USER.role==='Admin'),cols=[c.pk,...c.f.map(f=>f[0])];
 const rows=DB[t].filter(r=>!q||JSON.stringify(r).toLowerCase().includes(q.toLowerCase()));
 const cell=(r,k)=>k=='price'?\`<td class="r">\${peso(r[k])}</td>\`:k=='stock_quantity'?\`<td class="r"><span class="\${r[k]<=5?'warn':''}">\${r[k]}</span></td>\`:\`<td>\${esc(r[k])}</td>\`;
 $('#view').innerHTML=\`<div class="bar"><h2>\${c.title}</h2><span class="sp"></span><input id="q" type="search" placeholder="Search \${c.title.toLowerCase()}" value="\${esc(q)}">\${canWrite?\`<button class="b p" id="add">Add \${c.title.slice(0,-1).toLowerCase()}</button>\`:''}</div>
 <div class="box"><table><tr>\${cols.map(k=>\`<th class="\${k=='price'||k=='stock_quantity'?'r':''}">\${(c.f.find(f=>f[0]==k)||[0,'No.'])[1]}</th>\`).join('')}<th></th></tr>
 \${rows.map(r=>\`<tr>\${cols.map(k=>cell(r,k)).join('')}<td class="act">\${canWrite?\`<button class="b" data-e="\${r[c.pk]}">Edit</button><button class="b d" data-x="\${r[c.pk]}">Delete</button>\`:'<span class="mut">View only</span>'}</td></tr>\`).join('')}</table>\${rows.length?'':'<div class="empty">Nothing found. Add one with the button above.</div>'}</div>\`;
 const qi=$('#q');qi.oninput=()=>{q=qi.value;entity(t);const n=$('#q');n.focus();n.setSelectionRange(q.length,q.length)};
 if(canWrite) $('#add').onclick=()=>form(t);
 $('#view').onclick=e=>{const b=e.target;if(b.dataset.e)form(t,b.dataset.e);if(b.dataset.x)del(t,b.dataset.x)};
}
function form(t,id){
 const c=E[t],r=id?find(t,c.pk,id):{};
 openDlg(\`<div class="dh">\${id?'Edit':'Add'} \${c.title.slice(0,-1).toLowerCase()}</div><div class="db">\${c.f.map(f=>\`<label>\${f[1]}<input name="\${f[0]}" type="\${f[2]}" \${f[2]=='number'?'min="0" step="any"':''} value="\${esc(r[f[0]]??(t==='products'&&f[0]==='low_stock_threshold'?5:''))}"></label>\`).join('')}<div class="err" id="err"></div></div><div class="df"><button class="b" data-c>Cancel</button><button class="b p" id="ok">Save</button></div>\`);
 $('#ok').onclick=async()=>{
  const v={};c.f.forEach(f=>{const x=$('#dlg [name='+f[0]+']').value.trim();v[f[0]]=f[2]=='number'?parseFloat(x):x});
  const bad=c.f.find(f=>f[0]!='description'&&f[0]!='address'&&f[0]!='phone'&&(v[f[0]]===''||Number.isNaN(v[f[0]])));
  if(bad)return $('#err').textContent=bad[1]+' is required.';
  if(t=='customers'&&DB.customers.some(x=>x.email.toLowerCase()==v.email.toLowerCase()&&x.customer_id!=id))return $('#err').textContent='That email is already used by another customer.';
  if(t=='products'){v.stock_quantity=Math.round(v.stock_quantity)}
  try{await api(id?'PUT':'POST','/'+t+(id?'/'+id:''),v);await reload();$('#dlg').close();toast('Saved');render()}catch(e){$('#err').textContent=e.message}
 };
}
async function del(t,id){
 const [rt,rk]=refs[t];
 if(DB[rt].some(x=>x[rk]==id))return toast('Cannot delete: used by existing orders');
 if(!confirm('Delete this record?'))return;
 try{await api('DELETE','/'+t+'/'+id);await reload();toast('Deleted');render()}catch(e){toast(e.message)}
}
function openDlg(h){const d=$('#dlg');d.innerHTML=h;d.onclick=e=>{if(e.target.dataset.c!==undefined)d.close()};d.showModal()}

function orderItems(){
 const pn=id=>find('products','product_id',id)?.product_name||'—';
 const rows=[...DB.order_items].sort((a,b)=>b.order_item_id-a.order_item_id).filter(i=>{const o=find('orders','order_id',i.order_id);return !q||(pn(i.product_id)+' #'+i.order_id+' '+(o?cname(o.customer_id):'')).toLowerCase().includes(q.toLowerCase())});
 $('#view').innerHTML=\`<div class="bar"><h2>Order items</h2><span class="sp"></span><input id="q" type="search" placeholder="Search order items" value="\${esc(q)}"><button class="b p" id="add">Add item to order</button></div>
 <div class="box"><table><tr><th>Item no.</th><th>Order no.</th><th>Customer</th><th>Product</th><th class="r">Quantity</th><th class="r">Unit price</th><th class="r">Subtotal</th><th></th></tr>
 \${rows.map(i=>{const o=find('orders','order_id',i.order_id);return \`<tr><td>\${i.order_item_id}</td><td>#\${i.order_id}</td><td>\${esc(o?cname(o.customer_id):'—')}</td><td>\${esc(pn(i.product_id))}</td><td class="r">\${i.quantity}</td><td class="r">\${peso(i.unit_price)}</td><td class="r">\${peso(i.quantity*i.unit_price)}</td><td class="act">\${find('orders','order_id',i.order_id)?.status==='Pending' ? '<button class="b" data-e="'+i.order_item_id+'">Edit</button><button class="b d" data-x="'+i.order_item_id+'">Delete</button>' : '<span class="mut">Locked</span>'}</td></tr>\`}).join('')}</table>\${rows.length?'':'<div class="empty">No order items yet. Create an order first, or add an item to an existing order.</div>'}</div>\`;
 const qi=$('#q');qi.oninput=()=>{q=qi.value;orderItems();const n=$('#q');n.focus();n.setSelectionRange(q.length,q.length)};
 $('#add').onclick=()=>itemForm();
 $('#view').onclick=e=>{const b=e.target;if(b.dataset.e)itemForm(b.dataset.e);if(b.dataset.x)itemDel(b.dataset.x)};
}
function itemForm(id){
 const it=id?find('order_items','order_item_id',id):null;
 const open=DB.orders.filter(o=>o.status==='Pending');
 if(!id&&!open.length)return toast('Create an order first');
 const oo=open.map(o=>\`<option value="\${o.order_id}">#\${o.order_id} · \${esc(cname(o.customer_id))}</option>\`).join('');
 const po=DB.products.map(p=>\`<option value="\${p.product_id}" \${p.stock_quantity<1?'disabled':''}>\${esc(p.product_name)} · \${peso(p.price)} (\${p.stock_quantity} in stock)</option>\`).join('');
 openDlg(\`<div class="dh">\${id?'Edit order item':'Add item to order'}</div><div class="db">\${id?\`<div>Order #\${it.order_id} · \${esc(find('products','product_id',it.product_id)?.product_name)}</div>\`:\`<label>Order<select id="io">\${oo}</select></label><label>Product<select id="ip">\${po}</select></label>\`}<label>Quantity<input id="iq" type="number" min="1" value="\${it?it.quantity:1}"></label><div class="err" id="err"></div></div><div class="df"><button class="b" data-c>Cancel</button><button class="b p" id="ok">Save</button></div>\`);
 $('#ok').onclick=async()=>{const quantity=parseInt($('#iq').value);if(!(quantity>=1))return $('#err').textContent='Quantity must be at least 1.';
  try{id?await api('PUT','/order-items/'+id,{quantity}):await api('POST','/order-items',{order_id:+$('#io').value,product_id:+$('#ip').value,quantity});await reload();$('#dlg').close();toast('Saved');render()}catch(e){$('#err').textContent=e.message}};
}
async function itemDel(id){if(!confirm('Remove this item from the order?'))return;try{await api('DELETE','/order-items/'+id);await reload();toast('Deleted');render()}catch(e){toast(e.message)}}
async function stockHistory(){
 const rows=await api('GET','/stock-movements');
 $('#view').innerHTML=\`<div class="bar"><h2>Inventory movement history</h2><span class="sp"></span><button class="b" id="refresh">Refresh</button></div><div class="box"><table><tr><th>Date</th><th>Product</th><th>Movement</th><th class="r">Change</th><th>User</th><th>Note</th></tr>\${rows.map(x=>\`<tr><td>\${esc(String(x.created_at).replace('T',' ').slice(0,19))}</td><td>\${esc(x.product_name)}</td><td>\${esc(x.movement_type)}</td><td class="r"><span class="\${x.quantity_change<0?'bad':'ok'}">\${x.quantity_change>0?'+':''}\${x.quantity_change}</span></td><td>\${esc(x.full_name||'System')}</td><td>\${esc(x.note||'')}</td></tr>\`).join('')}</table>\${rows.length?'':'<div class="empty">No inventory movements yet.</div>'}</div>\`;
 $('#refresh').onclick=()=>stockHistory().catch(e=>toast(e.message));
}
async function salesReports(){
 const paid=DB.orders.filter(o=>['Paid','Shipped','Completed'].includes(o.status));
 const pending=DB.orders.filter(o=>o.status==='Pending');
 const cancelled=DB.orders.filter(o=>o.status==='Cancelled');
 const total=arr=>arr.reduce((n,o)=>n+ototal(o.order_id),0);
 const best={};DB.order_items.forEach(i=>{const p=find('products','product_id',i.product_id);const k=p?.product_name||'Unknown';best[k]=(best[k]||0)+i.quantity});
 const top=Object.entries(best).sort((a,b)=>b[1]-a[1]).slice(0,10);
 $('#view').innerHTML=\`<div class="bar"><h2>Sales reports</h2><span class="sp"></span><button class="b" id="printReport">Print report</button></div><div class="stats"><div class="st"><b>\${peso(total(paid))}</b><span>Recognized order value</span></div><div class="st"><b>\${peso(total(pending))}</b><span>Pending order value</span></div><div class="st"><b>\${peso(total(cancelled))}</b><span>Cancelled order value</span></div><div class="st"><b>\${paid.length}</b><span>Paid / shipped / completed orders</span></div></div><div class="box"><h3>Top products by units in recorded orders</h3><table><tr><th>Product</th><th class="r">Units</th></tr>\${top.map(x=>\`<tr><td>\${esc(x[0])}</td><td class="r">\${x[1]}</td></tr>\`).join('')||'<tr><td colspan="2" class="empty">No product sales yet.</td></tr>'}</table></div><p class="mut">Figures are calculated from order status and saved order lines. They are not a payment reconciliation or profit report because the current database does not record payment transactions or product cost.</p>\`;
 $('#printReport').onclick=()=>window.print();
}
async function usersPage(){
 const rows=await api('GET','/users');
 $('#view').innerHTML=\`<div class="bar"><h2>User accounts</h2><span class="sp"></span><button class="b p" id="addUser">Create account</button></div><div class="box"><table><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr>\${rows.map(u=>\`<tr><td>\${esc(u.full_name)}</td><td>\${esc(u.email)}</td><td>\${esc(u.role)}</td><td>\${u.is_active?'Active':'Disabled'}</td><td class="act"><button class="b" data-user="\${u.user_id}" data-active="\${u.is_active?0:1}">\${u.is_active?'Disable':'Enable'}</button></td></tr>\`).join('')}</table></div>\`;
 $('#addUser').onclick=()=>openDlg(\`<div class="dh">Create user account</div><div class="db"><label>Full name<input id="un"></label><label>Email<input id="ue" type="email"></label><label>Temporary password (12+ characters)<input id="up" type="password"></label><label>Role<select id="ur"><option>Cashier</option><option>Manager</option><option>Inventory Staff</option><option>Admin</option></select></label><div class="err" id="err"></div></div><div class="df"><button class="b" data-c>Cancel</button><button class="b p" id="saveUser">Create</button></div>\`);
 $('#saveUser')?.addEventListener('click',async()=>{try{await api('POST','/users',{full_name:$('#un').value,email:$('#ue').value,password:$('#up').value,role:$('#ur').value});$('#dlg').close();toast('User created');usersPage()}catch(e){$('#err').textContent=e.message}});
 $('#view').onclick=async e=>{const b=e.target.closest('[data-user]');if(!b)return;try{await api('PUT','/users/'+b.dataset.user,{is_active:b.dataset.active==='1'});toast('Account updated');usersPage()}catch(err){toast(err.message)}};
}
function showLogin(){
 document.body.innerHTML=\`<main style="margin:auto;width:min(420px,94vw);padding:24px"><div class="box" style="padding:24px"><h2>BitByte PC Parts</h2><p class="mut">Sign in to Store Manager</p><form id="loginForm" style="display:grid;gap:14px"><label>Email<input id="loginEmail" type="email" required autocomplete="username"></label><label>Password<input id="loginPassword" type="password" required autocomplete="current-password"></label><div class="err" id="loginError"></div><button class="b p" type="submit">Sign in</button></form></div></main>\`;
 $('#loginForm').onsubmit=async e=>{e.preventDefault();try{const r=await api('POST','/auth/login',{email:$('#loginEmail').value,password:$('#loginPassword').value});CURRENT_USER=r.user;location.reload()}catch(err){$('#loginError').textContent=err.message}};
}
function orders(){
 const rows=[...DB.orders].sort((a,b)=>b.order_id-a.order_id).filter(o=>!q||(cname(o.customer_id)+ename(o.employee_id)+o.status+o.order_id).toLowerCase().includes(q.toLowerCase()));
 $('#view').innerHTML=\`<div class="bar"><h2>Orders</h2><span class="sp"></span><input id="q" type="search" placeholder="Search orders" value="\${esc(q)}"><button class="b p" id="add">New order</button></div>
 <div class="box"><table><tr><th>Order no.</th><th>Customer</th><th>Employee</th><th>Date</th><th>Status</th><th class="r">Total</th><th></th></tr>
 \${rows.map(o=>\`<tr><td>#\${o.order_id}</td><td>\${esc(cname(o.customer_id))}</td><td>\${esc(ename(o.employee_id))}</td><td>\${o.order_date.replace('T',' ').slice(0,16)}</td><td><span class="tag \${scls(o.status)}">\${o.status}</span></td><td class="r">\${peso(ototal(o.order_id))}</td><td class="act"><button class="b" data-o="\${o.order_id}">View</button></td></tr>\`).join('')}</table>\${rows.length?'':'<div class="empty">No orders found. Create one with New order.</div>'}</div>\`;
 const qi=$('#q');qi.oninput=()=>{q=qi.value;orders();const n=$('#q');n.focus();n.setSelectionRange(q.length,q.length)};
 $('#add').onclick=newOrder;
 $('#view').onclick=e=>{if(e.target.dataset.o)viewOrder(e.target.dataset.o)};
}
function newOrder(){
 if(!DB.customers.length||!DB.employees.length||!DB.products.length)return toast('Add a customer, employee and product first');
 const opt=(t,k,fn)=>DB[t].map(r=>\`<option value="\${r[k]}">\${esc(fn(r))}</option>\`).join('');
 const prod=DB.products.map(p=>\`<option value="\${p.product_id}" \${p.stock_quantity<1?'disabled':''}>\${esc(p.product_name)} · \${peso(p.price)} (\${p.stock_quantity} in stock)</option>\`).join('');
 const row=()=>\`<div class="irow"><select class="pi">\${prod}</select><input class="qi" type="number" min="1" value="1"><button class="b d" data-rm>×</button></div>\`;
 openDlg(\`<div class="dh">New order</div><div class="db"><label>Customer<select id="oc">\${opt('customers','customer_id',c=>c.first_name+' '+c.last_name)}</select></label><label>Handled by<select id="oe">\${opt('employees','employee_id',e=>e.first_name+' '+e.last_name+' ('+e.role+')')}</select></label><div id="items">\${row()}</div><button class="b" id="ai">Add item</button><b id="tot"></b><div class="err" id="err"></div></div><div class="df"><button class="b" data-c>Cancel</button><button class="b p" id="ok">Create order</button></div>\`);
 const lines=()=>[...document.querySelectorAll('#items .irow')].map(r=>({product_id:+r.querySelector('.pi').value,quantity:parseInt(r.querySelector('.qi').value)||0}));
 const tot=()=>{$('#tot').textContent='Total: '+peso(lines().reduce((s,l)=>s+l.quantity*(find('products','product_id',l.product_id)?.price||0),0))};
 tot();
 $('#ai').onclick=()=>{$('#items').insertAdjacentHTML('beforeend',row());tot()};
 $('#dlg').addEventListener('input',tot);
 $('#items').onclick=e=>{if(e.target.dataset.rm!==undefined&&document.querySelectorAll('#items .irow').length>1){e.target.parentNode.remove();tot()}};
 $('#ok').onclick=async()=>{
  const L=lines(),need={};
  for(const l of L){if(l.quantity<1)return $('#err').textContent='Quantity must be at least 1.';need[l.product_id]=(need[l.product_id]||0)+l.quantity}
  for(const id in need){const p=find('products','product_id',id);if(need[id]>p.stock_quantity)return $('#err').textContent=\`Only \${p.stock_quantity} of \${p.product_name} in stock.\`}
  try{await api('POST','/orders',{customer_id:+$('#oc').value,employee_id:+$('#oe').value,items:L});await reload();$('#dlg').close();toast('Order created');render()}catch(e){$('#err').textContent=e.message}
 };
}
function viewOrder(id){
 const o=find('orders','order_id',id),its=DB.order_items.filter(i=>i.order_id==id);
 openDlg(\`<div class="dh">Order #\${o.order_id}</div><div class="db"><div>\${esc(cname(o.customer_id))} · handled by \${esc(ename(o.employee_id))}<br><span class="mut">\${o.order_date.replace('T',' ').slice(0,16)}</span></div>
 <table><tr><th>Product</th><th class="r">Qty</th><th class="r">Unit price</th><th class="r">Subtotal</th></tr>\${its.map(i=>\`<tr><td>\${esc(find('products','product_id',i.product_id)?.product_name)}</td><td class="r">\${i.quantity}</td><td class="r">\${peso(i.unit_price)}</td><td class="r">\${peso(i.quantity*i.unit_price)}</td></tr>\`).join('')}</table>
 <b>Total: \${peso(ototal(id))}</b>
 <label>Status<select id="os" \${o.status=='Cancelled'?'disabled':''}>\${STATUS.map(s=>\`<option \${s==o.status?'selected':''}>\${s}</option>\`).join('')}</select></label></div>
 <div class="df"><button class="b" id="printOrder">Print receipt</button><button class="b d" id="dl">Delete order</button><span style="flex:1"></span><button class="b" data-c>Close</button><button class="b p" id="ok">Save status</button></div>\`);
 $('#printOrder').onclick=()=>{
  const receiptRows=its.map(i=>\`<tr><td>\${esc(find('products','product_id',i.product_id)?.product_name||'Product')}</td><td>\${i.quantity}</td><td>\${peso(i.unit_price)}</td><td>\${peso(i.quantity*i.unit_price)}</td></tr>\`).join('');
  const w=window.open('','_blank','width=620,height=760');
  if(!w)return toast('Allow pop-ups to print the receipt.');
  w.document.write(\`<!doctype html><html><head><title>BitByte Receipt #\${o.order_id}</title><style>body{font:14px Arial;padding:28px;color:#111}h1{font-size:22px}table{width:100%;border-collapse:collapse;margin-top:20px}th,td{padding:8px;border-bottom:1px solid #ddd;text-align:left} .r{text-align:right}.total{font-size:18px;font-weight:bold;text-align:right;margin-top:20px}</style></head><body><h1>BitByte PC Parts</h1><p>Order receipt #\${o.order_id}<br>\${esc(String(o.order_date).replace('T',' ').slice(0,16))}<br>Customer: \${esc(cname(o.customer_id))}<br>Handled by: \${esc(ename(o.employee_id))}<br>Status: \${esc(o.status)}</p><table><tr><th>Item</th><th>Qty</th><th>Unit price</th><th>Subtotal</th></tr>\${receiptRows}</table><p class="total">Total: \${peso(ototal(id))}</p><p>Thank you for shopping with BitByte PC Parts!</p></body></html>\`);
  w.document.close(); w.focus(); w.print();
 };
 $('#ok').onclick=async()=>{try{await api('PUT','/orders/'+id,{status:$('#os').value});await reload();$('#dlg').close();toast('Order updated');render()}catch(e){toast(e.message)}};
 $('#dl').onclick=async()=>{if(!confirm('Delete this order and its items?'))return;try{await api('DELETE','/orders/'+id);await reload();$('#dlg').close();toast('Order deleted');render()}catch(e){toast(e.message)}};
}

api('GET','/auth/me').then(async x=>{if(!x.user){showLogin();return}CURRENT_USER=x.user;await reload();render()}).catch(()=>showLogin());
</script>
</body>
</html>
`;

setup()
  .then(() => {
    if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) throw new Error('Set SESSION_SECRET to a random value of at least 32 characters before starting.');
    const port=Number(process.env.PORT||3000);
    app.listen(port, '127.0.0.1', () => console.log(`Store running at http://127.0.0.1:${port}`));
  })
  .catch(err => { console.error('Database setup failed:', err.message); process.exit(1); });
