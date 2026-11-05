// طبقة البيانات: نفس الدوال تشتغل في وضع التجربة (على نفس الجهاز) أو مع Supabase (أونلاين)
(function () {
  const cfg = window.CAFE_CONFIG || {};
  const LIVE = !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && window.supabase);
  const STATUS = { new: 'جديد', accepted: 'يتحضّر', ready: 'جاهز', done: 'تم التسليم', rejected: 'مرفوض' };

  const listeners = { orders: new Set(), menu: new Set() };
  function fire(topic) {
    listeners[topic].forEach(fn => { try { fn(); } catch (e) { console.error(e); } });
  }

  // ---------- أدوات مشتركة
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function money(n, cur) {
    const v = Number(n || 0);
    return (Number.isInteger(v) ? v : v.toFixed(2)) + ' ' + (cur || 'ر.س');
  }
  function toast(msg) {
    let t = document.querySelector('.toast');
    if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('show');
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2800);
  }
  function applyBrand(settings) {
    if (settings && /^#[0-9a-f]{6}$/i.test(settings.color || '')) document.documentElement.style.setProperty('--brand', settings.color);
  }
  function uid() {
    return (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2));
  }
  async function compressImage(file, max = 720, quality = 0.8) {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('الصورة ما انقرت')); i.src = url; });
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return await new Promise(res => c.toBlob(res, 'image/webp', quality));
    } finally { URL.revokeObjectURL(url); }
  }
  function blobToDataURL(b) {
    return new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(b); });
  }
  function demoBanner() {
    if (LIVE) return;
    const b = document.createElement('div');
    b.className = 'demo-banner';
    b.innerHTML = '<b>وضع التجربة</b> · البيانات محفوظة على هذا الجهاز بس. افتح الصفحات في تبويبات بنفس المتصفح وجرّب.';
    document.body.prepend(b);
  }

  // ---------- وضع التجربة (localStorage)
  function demoImpl() {
    const KEY = 'cafe-demo-db-v1', REV = KEY + '-rev';
    let bc = null;
    try { bc = new BroadcastChannel('cafe-demo'); bc.onmessage = e => fire(e.data); } catch (e) { }
    window.addEventListener('storage', e => { if (e.key === REV) { fire('orders'); fire('menu'); } });
    let lastRev = localStorage.getItem(REV);
    setInterval(() => {
      const r = localStorage.getItem(REV);
      if (r !== lastRev) { lastRev = r; fire('orders'); fire('menu'); }
    }, 2000);

    function read() {
      try { const d = JSON.parse(localStorage.getItem(KEY)); if (d && d.items) return d; } catch (e) { }
      const d = seed(); localStorage.setItem(KEY, JSON.stringify(d)); return d;
    }
    function write(d, topic) {
      if (d.orders.length > 300) d.orders = d.orders.slice(-300);
      try { localStorage.setItem(KEY, JSON.stringify(d)); }
      catch (e) { toast('مساحة وضع التجربة امتلأت، قلّل الصور'); throw e; }
      lastRev = String(Date.now() + Math.random());
      localStorage.setItem(REV, lastRev);
      if (bc) bc.postMessage(topic);
      fire(topic);
    }
    const byId = (arr, id) => arr.find(x => x.id === id);

    return {
      async getMenu() {
        const d = read();
        return {
          settings: d.settings,
          categories: [...d.categories].sort((a, b) => a.sort - b.sort || a.id - b.id),
          items: [...d.items].sort((a, b) => a.sort - b.sort || a.id - b.id)
        };
      },
      async saveSettings(s) { const d = read(); d.settings = { ...d.settings, ...s }; write(d, 'menu'); },
      async saveCategory(c) {
        const d = read();
        if (c.id) Object.assign(byId(d.categories, c.id), c);
        else { c = { sort: d.categories.length + 1, ...c, id: ++d.nextId }; d.categories.push(c); }
        write(d, 'menu'); return c;
      },
      async deleteCategory(id) {
        const d = read();
        d.categories = d.categories.filter(c => c.id !== id);
        d.items.forEach(i => { if (i.category_id === id) i.category_id = null; });
        write(d, 'menu');
      },
      async saveItem(it) {
        const d = read();
        if (it.id) Object.assign(byId(d.items, it.id), it);
        else { it = { sort: 0, available: true, ...it, id: ++d.nextId }; d.items.push(it); }
        write(d, 'menu'); return it;
      },
      async deleteItem(id) { const d = read(); d.items = d.items.filter(i => i.id !== id); write(d, 'menu'); },
      async uploadImage(file) { return blobToDataURL(await compressImage(file, 480, 0.72)); },

      async placeOrder({ table, items, note }) {
        const d = read();
        if (d.settings.is_open === false) throw new Error('المقهى ما يستقبل طلبات الحين');
        if (!(table >= 0 && table <= (d.settings.tables_count || 50))) throw new Error('رقم الطاولة غير صحيح');
        const lines = []; let total = 0;
        for (const { id, qty } of items) {
          if (!(qty >= 1 && qty <= 20)) throw new Error('كمية غير صحيحة');
          const it = d.items.find(i => i.id === id && i.available);
          if (!it) continue;
          lines.push({ id, name: it.name, price: it.price, qty });
          total += it.price * qty;
        }
        if (!lines.length) throw new Error('الأصناف اللي اخترتها غير متوفرة');
        const o = { id: uid(), order_no: d.nextNo++, table_no: table, items: lines, note: (note || '').slice(0, 200), total, status: 'new', created_at: new Date().toISOString() };
        d.orders.push(o); write(d, 'orders');
        return { id: o.id, order_no: o.order_no, total };
      },
      async getOrder(id) { return byId(read().orders, id) || null; },
      async listOrders() {
        const since = Date.now() - 24 * 3600e3;
        return read().orders.filter(o => new Date(o.created_at).getTime() > since);
      },
      async updateOrderStatus(id, status) {
        const d = read(); const o = byId(d.orders, id);
        if (o) { o.status = status; write(d, 'orders'); }
      },

      async getSession() { return sessionStorage.getItem('cafe-demo-staff') === '1' ? { demo: true } : null; },
      async signIn(user, pass) {
        if (pass !== '1234') throw new Error('الرمز غلط. في وضع التجربة الرمز هو 1234');
        sessionStorage.setItem('cafe-demo-staff', '1');
      },
      async signOut() { sessionStorage.removeItem('cafe-demo-staff'); },
      async resetDemo() { localStorage.removeItem(KEY); read(); write(read(), 'menu'); fire('orders'); }
    };
  }

  function seed() {
    let id = 0;
    const cat = (name, sort) => ({ id: ++id, name, sort });
    const c1 = cat('قهوة ساخنة', 1), c2 = cat('قهوة باردة', 2), c3 = cat('مشروبات ثانية', 3), c4 = cat('حلا', 4);
    const it = (c, name, price, calories, emoji, description = '') =>
      ({ id: ++id, category_id: c.id, name, description, price, calories, emoji, image_url: null, available: true, sort: id });
    return {
      settings: { cafe_name: 'كوفي رمال', color: '#b5652b', currency: 'ر.س', tables_count: 12, is_open: true },
      categories: [c1, c2, c3, c4],
      items: [
        it(c1, 'إسبريسو', 12, 5, '☕', 'شوت مركّز من محمصة محلية'),
        it(c1, 'كابتشينو', 16, 130, '☕', 'إسبريسو مع حليب ورغوة كثيفة'),
        it(c1, 'لاتيه', 17, 190, '🥛'),
        it(c1, 'فلات وايت', 16, 120, '☕'),
        it(c1, 'قهوة سعودية', 25, 10, '🫖', 'دلة تكفي ٣ أشخاص مع تمر'),
        it(c1, 'V60', 18, 5, '⚗️', 'قهوة مقطّرة، اسأل عن محصول اليوم'),
        it(c2, 'آيس لاتيه', 18, 150, '🧊'),
        it(c2, 'آيس سبانش لاتيه', 20, 260, '🧋', 'حليب مكثّف محلى'),
        it(c2, 'كولد برو', 17, 10, '🧊', 'منقوع ١٨ ساعة'),
        it(c3, 'ماتشا لاتيه', 20, 180, '🍵'),
        it(c3, 'شاي كرك', 10, 160, '🫖'),
        it(c3, 'هوت شوكلت', 16, 290, '🍫'),
        it(c4, 'كوكيز', 9, 210, '🍪'),
        it(c4, 'كرواسون زبدة', 12, 270, '🥐'),
        it(c4, 'سان سباستيان', 24, 450, '🍰', 'تشيز كيك محروق، قطعة')
      ],
      orders: [], nextId: 100, nextNo: 1
    };
  }

  // ---------- الوضع المباشر (Supabase)
  function liveImpl() {
    const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    const chk = ({ data, error }) => { if (error) throw new Error(error.message); return data; };
    const num = o => ({ ...o, price: o.price != null ? Number(o.price) : o.price, total: o.total != null ? Number(o.total) : o.total });
    const channels = {};

    return {
      _sb: sb,
      _ensure(topic) {
        if (channels[topic]) return;
        const ch = sb.channel(topic + '-live');
        const tables = topic === 'orders' ? ['orders'] : ['items', 'categories', 'settings'];
        tables.forEach(t => ch.on('postgres_changes', { event: '*', schema: 'public', table: t }, () => fire(topic)));
        channels[topic] = ch.subscribe();
      },
      async getMenu() {
        const [s, c, i] = await Promise.all([
          sb.from('settings').select('*').eq('id', 1).maybeSingle(),
          sb.from('categories').select('*').order('sort').order('id'),
          sb.from('items').select('*').order('sort').order('id')
        ]);
        return { settings: chk(s) || {}, categories: chk(c), items: chk(i).map(num) };
      },
      async saveSettings(s) { chk(await sb.from('settings').update(s).eq('id', 1)); },
      async saveCategory(c) {
        const { id, ...rest } = c;
        return chk(id ? await sb.from('categories').update(rest).eq('id', id).select().single()
                      : await sb.from('categories').insert(rest).select().single());
      },
      async deleteCategory(id) { chk(await sb.from('categories').delete().eq('id', id)); },
      async saveItem(it) {
        const { id, ...rest } = it;
        return num(chk(id ? await sb.from('items').update(rest).eq('id', id).select().single()
                          : await sb.from('items').insert(rest).select().single()));
      },
      async deleteItem(id) { chk(await sb.from('items').delete().eq('id', id)); },
      async uploadImage(file) {
        const blob = await compressImage(file, 720, 0.8);
        const path = 'items/' + uid() + '.webp';
        chk(await sb.storage.from('menu').upload(path, blob, { contentType: 'image/webp' }));
        return sb.storage.from('menu').getPublicUrl(path).data.publicUrl;
      },

      async placeOrder({ table, items, note }) {
        const d = chk(await sb.rpc('place_order', { p_table: table, p_items: items, p_note: note || null }));
        const r = Array.isArray(d) ? d[0] : d;
        return { id: r.id, order_no: r.order_no, total: Number(r.total) };
      },
      async getOrder(id) {
        const d = chk(await sb.rpc('order_status', { p_id: id }));
        const r = Array.isArray(d) ? d[0] : d;
        return r ? num({ ...r, id }) : null;
      },
      async listOrders() {
        const since = new Date(Date.now() - 24 * 3600e3).toISOString();
        return chk(await sb.from('orders').select('*').gte('created_at', since).order('created_at')).map(num);
      },
      async updateOrderStatus(id, status) { chk(await sb.from('orders').update({ status }).eq('id', id)); },

      async getSession() { const { data } = await sb.auth.getSession(); return data.session; },
      async signIn(email, pass) {
        const { error } = await sb.auth.signInWithPassword({ email: email.trim(), password: pass });
        if (error) throw new Error('الإيميل أو كلمة المرور غلط');
      },
      async signOut() { await sb.auth.signOut(); }
    };
  }

  const impl = LIVE ? liveImpl() : demoImpl();

  async function requireStaff(title) {
    const s = await impl.getSession();
    if (s) return s;
    return new Promise(resolve => {
      const wrap = document.createElement('div');
      wrap.className = 'gate';
      wrap.innerHTML = `
        <form class="gate-card" autocomplete="on">
          <h1>${esc(title)}</h1>
          <p>${LIVE ? 'سجّل دخول بحساب الموظف' : 'وضع التجربة: الرمز هو <b>1234</b>'}</p>
          ${LIVE ? '<div class="field"><label for="g-u">الإيميل</label><input id="g-u" name="u" type="email" required autocomplete="username"></div>' : ''}
          <div class="field"><label for="g-p">${LIVE ? 'كلمة المرور' : 'الرمز'}</label>
            <input id="g-p" name="p" type="password" required autocomplete="current-password" ${LIVE ? '' : 'inputmode="numeric"'}></div>
          <div class="err" hidden></div>
          <button class="btn block">دخول</button>
        </form>`;
      document.body.appendChild(wrap);
      wrap.querySelector('input').focus();
      wrap.querySelector('form').addEventListener('submit', async e => {
        e.preventDefault();
        const f = e.target, err = wrap.querySelector('.err'), btn = f.querySelector('button');
        err.hidden = true; btn.disabled = true;
        try {
          await impl.signIn(f.u ? f.u.value : '', f.p.value);
          const s = await impl.getSession();
          wrap.remove(); resolve(s);
        } catch (x) { err.textContent = x.message; err.hidden = false; btn.disabled = false; }
      });
    });
  }

  window.CafeStore = Object.assign({
    LIVE, STATUS, esc, money, toast, applyBrand, compressImage, demoBanner, requireStaff,
    on(topic, fn) {
      listeners[topic].add(fn);
      if (impl._ensure) impl._ensure(topic);
      return () => listeners[topic].delete(fn);
    }
  }, impl);
})();
