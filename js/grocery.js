// Built-in grocery vocabulary for reading receipt lines, grouped by store section.
// Matching tolerates receipt abbreviations and camera misreads (e.g. "POJATPES" → potatoes, "MLJK" → milk).
const SECTIONS = {
  produce: `apple apples ambrosia gala fuji honeycrisp mcintosh granny banana bananas plantain pear pears bosc anjou bartlett orange oranges navel
    mandarin mandarins clementine clementines tangerine grapefruit lemon lemons lime limes grape grapes berry berries strawberry strawberries
    blueberry blueberries raspberry raspberries blackberry blackberries cranberry cherry cherries peach peaches nectarine plum plums apricot kiwi
    mango mangoes papaya pineapple melon watermelon cantaloupe honeydew pomegranate guava lychee fig dates coconut avocado avocados tomato tomatoes
    potato potatoes yam yams sweet onion onions shallot garlic ginger carrot carrots celery cucumber cucumbers zucchini squash pumpkin eggplant
    pepper peppers capsicum jalapeno chili chilli lettuce romaine iceberg spinach kale arugula cabbage broccoli cauliflower brussels sprout sprouts
    asparagus bean beans okra peas corn mushroom mushrooms radish beet beets turnip parsnip leek cilantro coriander parsley mint basil dill
    thyme rosemary methi fenugreek curry produce salad greens mesclun herbs microgreens organic`,
  dairy: `milk milks cream creamer half butter margarine ghee cheese cheddar mozzarella mozz parmesan parm feta brie gouda swiss havarti provolone
    ricotta cottage paneer yogurt yoghurt yogourt kefir eggs egg dairy lactose oatmilk almondmilk soymilk natrel lactantia beatrice dairyland
    neilson sealtest oikos activia danone liberte astro skyr`,
  meat: `chicken breast thigh thighs drumstick drumsticks wings wing beef steak ground mince pork chop chops bacon ham sausage sausages turkey lamb goat mutton
    veal ribs roast brisket salami pepperoni prosciutto deli meat meats fish salmon tilapia cod haddock tuna trout basa shrimp prawn prawns scallop
    crab lobster seafood hotdog hotdogs wieners burger burgers patties rotisserie`,
  bakery: `bread loaf baguette bagel bagels bun buns roll rolls croissant croissants muffin muffins donut donuts doughnut cake cakes pie pies tart
    pastry pastries brioche pita naan roti tortilla tortillas wrap wraps flatbread sourdough rye multigrain wholewheat ciabatta danish scone cupcake`,
  pantry: `rice basmati jasmine pasta spaghetti penne macaroni noodle noodles ramen flour atta maida sooji semolina sugar salt oil olive canola
    vegetable sunflower vinegar sauce ketchup mustard mayo mayonnaise relish salsa soy sriracha honey jam jelly syrup peanut nutella spread
    cereal oats oatmeal granola cornflakes cheerios flakes lentil lentils dal daal chana chickpea chickpeas rajma kidney moong urad toor masoor
    beans canned soup broth stock tomato paste puree spice spices masala turmeric haldi cumin jeera coriander garam chilli paprika cinnamon
    pepper oregano baking soda powder yeast vanilla cocoa coconut tahini hummus pickle pickles achaar olives nuts almond almonds cashew cashews
    walnut walnuts pistachio pistachios raisin raisins dried seeds quinoa couscous breadcrumbs stuffing gravy condiment dressing`,
  snacks: `chips crisps doritos lays ruffles pringles cheetos tostitos popcorn pretzel pretzels crackers cracker triscuit ritz goldfish cookie cookies
    biscuit biscuits shortbread kelsen oreo chocolate choco chocolates merci lindt ferrero toblerone kitkat snickers candy candies gummy gummies
    licorice mints gum granola bar bars snack snacks trail mix namkeen bhujia sev mixture rusk wafer wafers brownie brownies tin`,
  drinks: `water sparkling perrier juice juices orange apple lemonade pop soda cola coke pepsi sprite ginger ale gatorade powerade energy redbull
    coffee espresso tea chai green kombucha drink drinks beverage beverages tropicana minute maid oasis`,
  frozen: `frozen icecream ice cream gelato sorbet popsicle pizza pizzas fries nuggets waffles dumplings perogies pierogies samosa samosas paratha`,
  indian: `atta paneer ghee basmati masala dal daal chana rajma moong urad toor masoor besan jaggery gur pappadum papad poha suji sooji methi
    hing ajwain kasuri amul mdh everest haldiram haldirams shan parle britannia mtr`,
};
// Store brands / receipt prefixes that mean "food" when nothing else matches.
const FOOD_PREFIXES = /\b(ks|kirkland|gv|great value|pc|president'?s choice|no name|compliments|selection|irresistibles|our finest|sunrype)\b/i;

const SECTION_NAMES = {
  produce: ['produce', 'fruits & vegetables', 'fruit', 'vegetables'], dairy: ['dairy & eggs', 'dairy'], meat: ['meat & fish', 'meat', 'seafood'],
  bakery: ['bakery', 'bread'], pantry: ['pantry', 'staples'], snacks: ['snacks & drinks', 'snacks'], drinks: ['snacks & drinks', 'drinks', 'beverages'],
  frozen: ['frozen'], indian: ['indian groceries', 'indian'],
};

const DICT = new Map();
for (const [sec, list] of Object.entries(SECTIONS)) for (const w of list.split(/\s+/).filter(Boolean)) if (!DICT.has(w)) DICT.set(w, sec);
const WORDS = [...DICT.keys()];

function editDist(a, b, max = 2) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]; let best = i;
    for (let j = 1; j <= b.length; j++) { cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); best = Math.min(best, cur[j]); }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}
const singular = w => w.replace(/ies$/, 'y').replace(/oes$/, 'o').replace(/([^s])s$/, '$1');
// Receipt text → clean tokens (fix common OCR swaps inside words: 0→o, 1→l, 5→s, |→i).
export function tokens(desc) {
  return String(desc || '').toLowerCase().replace(/\|/g, 'i')
    .replace(/([a-z])0|0([a-z])/g, (m, a, b) => (a ? a + 'o' : 'o' + b)).replace(/([a-z])1|1([a-z])/g, (m, a, b) => (a ? a + 'l' : 'l' + b)).replace(/([a-z])5([a-z])/g, '$1s$2')
    .replace(/[^a-z ]+/g, ' ').split(/\s+/).filter(w => w.length >= 2);
}
// Best grocery section for an item line, or null. how: exact | fuzzy | prefix | brand
export function grocerySection(desc) {
  const toks = tokens(desc);
  for (let i = 0; i < toks.length - 1; i++) { const bi = toks[i] + toks[i + 1]; if (DICT.has(bi)) return { section: DICT.get(bi), how: 'exact', word: bi }; }
  for (const t of toks) { if (DICT.has(t)) return { section: DICT.get(t), how: 'exact', word: t }; const s = singular(t); if (DICT.has(s)) return { section: DICT.get(s), how: 'exact', word: s }; }
  for (const t of toks) {
    if (t.length < 4) continue;
    let best = null, bd = 9;
    for (const w of WORDS) {
      if (w.length < 4 || Math.abs(w.length - t.length) > 2) continue;
      const d = editDist(t, w, 2);
      const ok = t.length >= 7 ? d <= 2 : t.length >= 5 ? d <= 1 || (d === 2 && t[0] === w[0] && t.length === w.length) : d <= 1 || (d === 2 && t[0] === w[0] && t.at(-1) === w.at(-1) && t.length === w.length);
      if (ok && d < bd) { best = w; bd = d; }
    }
    if (best) return { section: DICT.get(best), how: 'fuzzy', word: best };
  }
  for (const t of toks) if (t.length >= 4) { const w = WORDS.find(w => w.length > t.length && w.startsWith(t)); if (w) return { section: DICT.get(w), how: 'prefix', word: w }; }
  if (FOOD_PREFIXES.test(' ' + desc + ' ')) return { section: null, how: 'brand' };
  return null;
}
// Pick the user's category for a section: a matching subcategory under Groceries if they have one, else Groceries itself.
export function sectionCategory(cats, section) {
  const exp = cats.filter(c => c.type === 'expense');
  const groc = exp.find(c => !c.parentId && /^groceries?$/i.test(c.name.trim())) || exp.find(c => !c.parentId && /grocer/i.test(c.name)) || exp.find(c => !c.parentId && /^food$/i.test(c.name.trim()));
  if (section && groc) for (const n of SECTION_NAMES[section] || []) {
    const sub = exp.find(c => c.parentId === groc.id && c.name.toLowerCase() === n);
    if (sub) return sub.id;
  }
  return groc?.id || null;
}
