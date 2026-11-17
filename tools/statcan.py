"""Fetch Statistics Canada food price data for MoneyBook's Price book.

Writes data/statcan.json with:
  cpi:     Consumer Price Index (table 18-10-0004-01, 2002=100), food groups, Canada and Ontario, monthly
  prices:  Monthly average retail prices for selected products (table 18-10-0245-01), Canada and Ontario
Run by .github/workflows/statcan.yml. Standard library only.
"""
import csv, io, json, re, sys, urllib.request, zipfile, datetime

GEOS = {"Canada", "Ontario"}
SINCE = "2017-01"
CPI_WANT = re.compile(r"^(All-items|Food|Food purchased from stores|Meat|Fresh or frozen meat.*|Fish, seafood and other marine products|"
                      r"Dairy products and eggs|Dairy products|Eggs|Bakery and cereal products.*|Fruit, fruit preparations and nuts|Fresh fruit|"
                      r"Vegetables and vegetable preparations|Fresh vegetables|Other food products and non-alcoholic beverages|"
                      r"Sugar and confectionery|Edible fats and oils|Coffee and tea|Non-alcoholic beverages)$")

UA = {"User-Agent": "MoneyBook-price-book/1.0 (personal finance app; https://github.com/lalli87/Moneymanage)"}

def get(url, timeout=300):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout) as r:
        return r.read()

def table(pid):
    # Statistics Canada's Web Data Service (the official API) gives the current full-table download link.
    j = json.loads(get(f"https://www150.statcan.gc.ca/t1/wds/rest/getFullTableDownloadCSV/{pid}/en", 60))
    if j.get("status") != "SUCCESS":
        raise RuntimeError(f"WDS: {j}")
    z = zipfile.ZipFile(io.BytesIO(get(j["object"])))
    name = next(n for n in z.namelist() if n.endswith(".csv") and "MetaData" not in n)
    text = z.read(name).decode("utf-8-sig")
    rows = csv.DictReader(io.StringIO(text))
    prod_col = next(c for c in rows.fieldnames if c.startswith("Products"))
    return rows, prod_col

def collect(pid, want=None):
    rows, pc = table(pid)
    months, data, seen = set(), {}, set()
    for r in rows:
        d = r["REF_DATE"][:7]
        if d < SINCE or r["GEO"] not in GEOS or not r["VALUE"]:
            continue
        p = r[pc].strip(); seen.add(p)
        if want and not want.match(p):
            continue
        months.add(d)
        data.setdefault(r["GEO"], {}).setdefault(p, {})[d] = float(r["VALUE"])
    return sorted(months), data, seen

def pack(months, data):
    idx = {m: i for i, m in enumerate(months)}
    out = {}
    for geo, prods in data.items():
        out[geo] = {}
        for p, vals in prods.items():
            arr = [None] * len(months)
            for m, v in vals.items(): arr[idx[m]] = v
            out[geo][p] = arr
    return out

cm, cd, cseen = collect("18100004", CPI_WANT)
print("CPI series kept:", sorted({p for g in cd.values() for p in g}), file=sys.stderr)
pm, pd, _ = collect("18100245")
print("Average-price products:", len({p for g in pd.values() for p in g}), "months", pm[:1], pm[-1:], file=sys.stderr)
res = {
    "source": "Statistics Canada, tables 18-10-0004-01 (CPI, 2002=100) and 18-10-0245-01 (monthly average retail prices). Statistics Canada Open Licence.",
    "updated": datetime.date.today().isoformat(),
    "cpi": {"months": cm, "series": pack(cm, cd)},
    "prices": {"months": pm, "series": pack(pm, pd)},
    "cpiAllProducts": sorted(cseen),
}
try:   # don't commit a change that is only the date
    old = json.load(open("data/statcan.json")); old["updated"] = res["updated"]
    if old == res: print("No change", file=sys.stderr); sys.exit(0)
except (FileNotFoundError, ValueError):
    pass
with open("data/statcan.json", "w") as f:
    json.dump(res, f, separators=(",", ":"))
