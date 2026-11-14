// Shopping list logic, shared by the server (lib/shopping.js) and the page (public/shopping.js).
// The server keeps one shared state. Every change is an "op". The page applies the same ops to its
// copy straight away, so it works offline, and sends them to the server when it can.

export const DEFAULT_TEXT = `# Stores

## Costco
- chicken breasts
- ground beef
- ground pork
- flour tortillas
- shredded cheese
- spaghetti
- bread
- rice
- sour cream
- shrimp
- pork shoulder
- paper towels
- toilet paper
- garbage bags
- aluminum foil
- zipper bags

## H&W Produce
- garlic
- ginger
- onions
- red onion
- green onions
- bell peppers
- cucumbers
- tomatoes
- carrots
- celery
- cabbage
- green beans
- potatoes
- sweet potatoes
- broccoli
- spinach
- salad greens
- avocados
- limes
- bean sprouts
- cilantro

## Superstore
- sushi rice
- nori
- rice vinegar
- imitation crab
- pickled ginger
- wasabi
- sesame seeds
- chow mein noodles
- oyster sauce
- hoisin sauce
- sriracha
- coleslaw mix
- pasta sauce
- parmesan
- feta
- mozzarella
- tzatziki
- kalamata olives
- salsa
- pierogies
- smoked sausages
- meatballs
- sub buns
- small soup pasta
- chicken broth
- vegetable broth
- beef broth
- breadcrumbs
- eggs
- butter
- chickpeas
- kidney beans
- black beans
- corn
- diced tomatoes
- tomato paste
- dry lentils
- hummus
- tahini
- honey
- rice noodles
- thin sliced beef
- rice paper
- rice vermicelli
- peanut butter
- taco tortillas
- tortilla chips
- pepperoni
- yeast
- cornstarch
- orange juice
- bbq sauce
- soy sauce
- sesame oil
- olive oil
- cooking oil
- flour
- sugar
- salt
- pepper
- chili powder
- cumin
- oregano
- italian seasoning
- garlic powder
- red pepper flakes
- dish soap
- hand soap
- laundry detergent

# Meals

## Sushi
- sushi rice
- nori
- rice vinegar
- cucumbers
- avocados
- imitation crab
- soy sauce
- pickled ginger
- wasabi
- sesame seeds

## Quesadillas
- flour tortillas
- shredded cheese
- chicken breasts
- bell peppers
- onions
- salsa
- sour cream

## Greek wraps
- flour tortillas
- chicken breasts
- tzatziki
- feta
- cucumbers
- tomatoes
- red onion
- salad greens
- kalamata olives

## Chicken chow mein
- chow mein noodles
- chicken breasts
- cabbage
- carrots
- celery
- onions
- green onions
- garlic
- ginger
- soy sauce
- oyster sauce

## Spaghetti
- spaghetti
- pasta sauce
- ground beef
- parmesan
- garlic
- onions

## Chicken baked potatoes with green beans and salad
- chicken breasts
- potatoes
- green beans
- salad greens
- butter
- sour cream
- shredded cheese

## Buddha bowls
- rice
- chickpeas
- sweet potatoes
- broccoli
- spinach
- carrots
- avocados
- tahini

## Italian wedding soup
- ground beef
- chicken broth
- small soup pasta
- spinach
- carrots
- celery
- onions
- eggs
- breadcrumbs
- parmesan
- garlic

## Egg roll in a bowl
- ground pork
- coleslaw mix
- garlic
- ginger
- soy sauce
- sesame oil
- green onions
- sriracha

## Pierogies and sausages
- pierogies
- smoked sausages
- onions
- butter
- sour cream

## Meatball subs
- meatballs
- sub buns
- pasta sauce
- mozzarella

## Vegetarian lentil chili
- dry lentils
- diced tomatoes
- tomato paste
- kidney beans
- onions
- carrots
- celery
- bell peppers
- vegetable broth
- garlic
- chili powder
- cumin

## Veggie sandwich
- bread
- cucumbers
- tomatoes
- salad greens
- avocados
- bell peppers
- shredded cheese
- hummus

## Tortilla soup
- chicken breasts
- chicken broth
- diced tomatoes
- black beans
- corn
- onions
- garlic
- cumin
- chili powder
- tortilla chips
- shredded cheese
- sour cream
- limes

## Pho
- rice noodles
- beef broth
- thin sliced beef
- bean sprouts
- green onions
- limes
- ginger
- onions
- hoisin sauce
- sriracha
- cilantro

## Orange chicken
- chicken breasts
- orange juice
- soy sauce
- garlic
- ginger
- cornstarch
- sugar
- rice
- broccoli
- green onions

## Shrimp tacos
- shrimp
- taco tortillas
- cabbage
- limes
- avocados
- sour cream
- chili powder
- cilantro

## Homemade pizza
- flour
- yeast
- pasta sauce
- mozzarella
- pepperoni
- bell peppers
- onions

## Rice paper rolls with peanut sauce
- rice paper
- rice vermicelli
- shrimp
- cucumbers
- carrots
- salad greens
- peanut butter
- soy sauce
- hoisin sauce
- limes

## Honey chicken with roasted veg
- chicken breasts
- honey
- soy sauce
- garlic
- potatoes
- carrots
- broccoli
- olive oil

## Pulled pork with coleslaw
- pork shoulder
- bbq sauce
- coleslaw mix
- sub buns
- onions

# Common items
- salt
- pepper
- chili powder
- cumin
- oregano
- italian seasoning
- garlic powder
- red pepper flakes
- soy sauce
- sesame oil
- olive oil
- cooking oil
- flour
- sugar
- cornstarch

# Household and extras
- dish soap
- hand soap
- laundry detergent
- paper towels
- toilet paper
- garbage bags
- aluminum foil
- zipper bags
- eggs
- butter
- bread
`;

export const UNASSIGNED = 'Not assigned to a store';
export const key = (s) => String(s || '').trim().toLowerCase();

/** Reads the plain-text lists. Returns { d: { stores, meals, common, house }, warn }. */
export function parseDoc(txt) {
  const d = { stores: [], meals: [], common: [], house: [] };
  const warn = [];
  let sec = null;
  let grp = null;
  let m;
  for (const raw of String(txt || '').split('\n')) {
    const l = raw.trim();
    if (!l) continue;
    if ((m = l.match(/^#\s+(.*)$/))) {
      const t = m[1].toLowerCase();
      sec = t.includes('store') ? 'stores' : t.includes('meal') ? 'meals' : t.includes('common') ? 'common' : t.includes('house') ? 'house' : null;
      grp = null;
      if (!sec) warn.push(`Unknown section ignored: ${m[1]}.`);
    } else if ((m = l.match(/^##\s+(.*)$/))) {
      if (sec === 'stores' || sec === 'meals') { grp = { name: m[1].trim(), items: [] }; d[sec].push(grp); }
    } else if ((m = l.match(/^[-*]\s+(.*)$/))) {
      const it = m[1].trim();
      if (!it) continue;
      if (sec === 'common' || sec === 'house') d[sec].push(it);
      else if (grp) grp.items.push(it);
      else warn.push(`Item outside a group ignored: ${it}.`);
    }
  }
  return { d, warn };
}

/** Problems worth telling someone about after they save new lists. */
export function checkDoc(d) {
  const where = storeMap(d);
  const missing = new Set();
  d.meals.forEach((g) => g.items.forEach((i) => { if (!where.has(key(i))) missing.add(i); }));
  d.common.concat(d.house).forEach((i) => { if (!where.has(key(i))) missing.add(i); });
  const seen = new Map();
  const dup = new Set();
  d.stores.forEach((g) => g.items.forEach((i) => { const k = key(i); if (seen.has(k) && seen.get(k) !== g.name) dup.add(i); else seen.set(k, g.name); }));
  return { missing: [...missing], dup: [...dup] };
}

export function storeMap(d) {
  const where = new Map();
  d.stores.forEach((g) => g.items.forEach((it) => { if (!where.has(key(it))) where.set(key(it), { store: g.name, label: it }); }));
  return where;
}

export function emptyState() {
  return { text: DEFAULT_TEXT, meals: [], house: [], out: [], extras: [], checked: [] };
}

const setToggle = (arr, v, on) => {
  const s = new Set(arr);
  if (on) s.add(v); else s.delete(v);
  return [...s];
};

/** Keeps only selections that still exist in the lists. */
function prune(st, d) {
  const meals = new Set(d.meals.map((g) => g.name));
  const house = new Set(d.house.map(key));
  const common = new Set(d.common.map(key));
  st.meals = st.meals.filter((n) => meals.has(n));
  st.house = st.house.filter((k) => house.has(k));
  st.out = st.out.filter((k) => common.has(k));
  return st;
}

/**
 * Applies one change and returns the new state. Ops say the end result ("meal X is on"),
 * not "flip it", so replaying them after being offline gives the right answer.
 */
export function applyOp(state, op) {
  const st = structuredClone(state);
  const k = key(op.item);
  switch (op.type) {
    case 'meal': st.meals = setToggle(st.meals, op.name, !!op.on); break;
    case 'house': st.house = setToggle(st.house, k, !!op.on); break;
    case 'common': st.out = setToggle(st.out, k, !!op.out); break;
    case 'check': st.checked = setToggle(st.checked, k, !!op.on); break;
    case 'addExtra': {
      const item = String(op.item || '').trim().slice(0, 100);
      if (!item || st.extras.some((e) => e.id === op.id)) break;
      st.extras.push({ id: String(op.id).slice(0, 40), item, store: String(op.store || '').slice(0, 100) });
      st.checked = setToggle(st.checked, k, false); // a new request for something already ticked
      break;
    }
    case 'removeExtra': st.extras = st.extras.filter((e) => e.id !== op.id); break;
    case 'stockAll': st.out = []; break;
    case 'clearSel': st.meals = []; st.house = []; st.extras = []; st.checked = []; break;
    case 'done': return finishTrip(st);
    case 'setText': {
      const text = String(op.text || '').slice(0, 200000);
      const { d } = parseDoc(text);
      if (!d.stores.some((g) => g.items.length)) break; // never save lists with no stores
      st.text = text;
      prune(st, d);
      break;
    }
    default: break;
  }
  return st;
}

/** What to buy, grouped by store, in each store's own order. */
export function compute(state) {
  const { d } = parseDoc(state.text);
  const where = storeMap(d);
  const commonKeys = new Set(d.common.map(key));
  const meals = new Set(state.meals);
  const house = new Set(state.house);
  const out = new Set(state.out);
  const checked = new Set(state.checked);
  const wanted = new Map();
  const want = (name, source, store, extraId) => {
    const k = key(name);
    if (wanted.has(k)) {
      const w = wanted.get(k);
      if (extraId && !w.extraId) w.extraId = extraId;
      return;
    }
    const place = store ? { store, label: name } : (where.get(k) || { store: UNASSIGNED, label: name });
    wanted.set(k, { key: k, store: place.store, label: place.label, source, extraId });
  };
  d.meals.forEach((g) => { if (meals.has(g.name)) g.items.forEach((it) => { if (!commonKeys.has(key(it))) want(it, 'meal'); }); });
  d.common.forEach((it) => { if (out.has(key(it))) want(it, 'common'); });
  d.house.forEach((it) => { if (house.has(key(it))) want(it, 'house'); });
  state.extras.forEach((e) => want(e.item, 'extra', e.store || null, e.id));

  const names = d.stores.map((g) => g.name);
  const order = names.concat(UNASSIGNED);
  const stores = [];
  for (const store of order) {
    const base = ((d.stores.find((g) => g.name === store) || { items: [] }).items).map(key);
    const mine = [...wanted.values()].filter((w) => w.store === store || (store === UNASSIGNED && !names.includes(w.store)));
    if (!mine.length) continue;
    const pos = (w) => { const i = base.indexOf(w.key); return i < 0 ? 1e6 : i; };
    mine.sort((a, b) => pos(a) - pos(b));
    const items = mine.map((w) => ({ ...w, checked: checked.has(w.key) }));
    stores.push({ name: store, items, left: items.filter((i) => !i.checked).length });
  }
  return {
    d,
    stores,
    total: stores.reduce((n, s) => n + s.items.length, 0),
    left: stores.reduce((n, s) => n + s.left, 0),
    meals: d.meals.map((g) => ({ name: g.name, on: meals.has(g.name) })),
    common: d.common.map((it) => ({ label: it, key: key(it), out: out.has(key(it)) })),
    house: d.house.map((it) => ({ label: it, key: key(it), on: house.has(key(it)) })),
    storeNames: names,
  };
}

/**
 * Done shopping: ticked items were bought. Ticked common items are back in stock.
 * Anything not ticked is kept as a one-off item, so it is still on the list next trip.
 * Meals and household picks are cleared.
 */
function finishTrip(st) {
  const view = compute(st);
  const next = { ...st, meals: [], house: [], extras: [], checked: [] };
  const out = new Set(st.out);
  let n = 0;
  for (const s of view.stores) {
    for (const it of s.items) {
      if (it.source === 'common') {
        if (it.checked) out.delete(it.key);
      } else if (!it.checked) {
        next.extras.push({ id: `kept-${Date.now().toString(36)}-${n++}`, item: it.label, store: s.name === UNASSIGNED ? '' : s.name });
      }
    }
  }
  next.out = [...out];
  return next;
}
