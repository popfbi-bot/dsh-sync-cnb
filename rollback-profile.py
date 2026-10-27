#!/usr/bin/env python3
"""把 DSH desktop profile 回滚到 2026-10-26 12:48 的正常状态。

用途：启用 dsh-sync-cnb 后若 DSH 启动失败 / 配置被安全模式重置，
先完全退出 DSH，再运行本脚本，然后重新打开。

用法：
    python F:/AI/DSH/plugins/dsh-sync-cnb/rollback-profile.py
"""

import os
import shutil
import sys

PROFILE = r"F:/AI/DSH/profiles/desktop"
# 2026-10-26 12:48 的快照：16 个 bundles（已卸 dsh-our-free-model）、15 条 patch，不含同步插件。
# 这一版实际启动成功过，是可靠的回滚点。
STAMP = "20261026-124851"
PAIRS = [
    (f"package.json.dshsync-good-{STAMP}", "package.json"),
    (f"cordis.patch.yml.dshsync-good-{STAMP}", "cordis.patch.yml"),
]


def main():
    missing = [src for src, _ in PAIRS if not os.path.isfile(os.path.join(PROFILE, src))]
    if missing:
        print("缺备份文件，无法回滚：", ", ".join(missing))
        return 1
    for src, dst in PAIRS:
        shutil.copyfile(os.path.join(PROFILE, src), os.path.join(PROFILE, dst))
        print(f"restored {dst}")
    print("已回滚。确认 DSH 完全退出后再打开。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
