"""造几个假的"别的扩展"，给 test/popup-drive.mjs 当测试数据。

用法：
  uv run --with pillow python test/make-fixtures.py
  uv run --with pillow python test/make-fixtures.py --many 10   # 另出一批填充扩展

为什么要造而不用本机真装的：无头跑的是全新临时 profile，里面一个别的扩展都没有，
列表永远是空的；而真 profile 又不能拿来做自动化（扩展会被我们改状态）。
假扩展名固定，断言才有基准。

一批是 4 个（test/fixtures/），用来断言排序、图标两条路、开关行为、右键菜单。
另一批是 10 个（test/fixtures-many/），只为一件事：让列表长到要滚动，
好验滚动条不会压住右边的开关——本机 Edge 里真装了 11 个扩展，这是常态不是边角。
两批分开，是免得填充数据把断言的条数搅乱。
"""
import argparse
import json
import shutil
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "fixtures"
OUT_MANY = HERE / "fixtures-many"
ICON_SRC = HERE.parent / "icons" / "icon48.png"

FIXTURES = {
    # alpha 多带两样：选项页和主页。右键菜单里「打开选项页」「打开主页」两项得有个带这两样
    # 的扩展才测得成——不带的（gamma 就是）那两项本来就不该出现，也是要验的。
    "alpha-notes": {"name": "Alpha Notes", "icon": True, "options": True, "home": True},
    "beta-reader": {"name": "β 阅读器", "icon": False},
    "gamma-block": {"name": "Gamma Block", "icon": False},
    "long-name": {"name": "网页深色模式与护眼滤镜自动切换工具", "icon": False},
}

# 填充用的名字取得像真装的，列表长起来才像回事（截图尤其）。
# 一条注意：别用 Chrome 会从注册表自动装进每个新 profile 的那些外部扩展（本机实测是
# IDM Integration Module）——那会让列表里同名出现两次，截图看着像坏了。
FILLER = [
    "Tampermonkey", "OneTab", "AdGuard 广告拦截", "Dark Reader",
    "Bitwarden", "Save to Notion", "沉浸式翻译", "Wappalyzer",
    "JSON Viewer Pro", "屏幕截图与标注",
]


def write_ext(root, slug, name, icon=False, options=False, home=False):
    d = root / slug
    d.mkdir(parents=True, exist_ok=True)
    manifest = {
        "manifest_version": 3,
        "name": name,
        "version": "1.0.0",
        "description": "扩展开关的测试替身",
    }
    if icon:
        manifest["icons"] = {"48": "icon48.png"}
    if options:
        manifest["options_page"] = "options.html"
    if home:
        manifest["homepage_url"] = "https://example.com/" + slug
    (d / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if icon:
        shutil.copyfile(ICON_SRC, d / "icon48.png")
    if options:
        (d / "options.html").write_text(
            "<!doctype html>\n<meta charset=\"utf-8\">\n<title>" + name + " 选项</title>\n"
            "<p>测试替身的选项页</p>\n", encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--many", type=int, default=0, metavar="N",
                    help="另出 N 个填充扩展到 test/fixtures-many/")
    args = ap.parse_args()

    for d in (OUT, OUT_MANY) if args.many else (OUT,):
        if d.exists():
            shutil.rmtree(d)

    for slug, spec in FIXTURES.items():
        write_ext(OUT, slug, spec["name"], icon=spec["icon"],
                  options=spec.get("options", False), home=spec.get("home", False))
    print(f"{len(FIXTURES)} 个 → {OUT}")

    if args.many:
        names = (FILLER * ((args.many // len(FILLER)) + 1))[:args.many]
        for i, name in enumerate(names):
            # 一半带图标：滚动区里图片和瓦片混着才看得出对齐有没有问题
            write_ext(OUT_MANY, f"filler-{i:02d}", name, icon=(i % 2 == 0))
        print(f"{args.many} 个 → {OUT_MANY}")


if __name__ == "__main__":
    main()

