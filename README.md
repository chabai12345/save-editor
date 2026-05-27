# 🎮 Save Editor — 游戏存档编辑工具

**主玩单机自用，玩到哪种更新哪种。目前已支持 30+ 种引擎格式的自动识别。**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## ✨ 功能亮点

- **自动格式识别** — 扔进去就认，无需手动指定引擎类型
- **深度分析** — RPG Maker 系列可解析角色、物品、变量、开关
- **安全修改** — 修改前自动备份（`.bak`），改错了随时恢复
- **跨平台** — 基于 Node.js，Windows/macOS/Linux 通用
- **CLI 操作** — 脚本化批量处理，方便集成到工作流

## 🎯 支持引擎

| 引擎 | 格式 | 支持程度 |
|------|------|---------|
| **RPG Maker MV** | `.rpgsave` | ✅ 读写 + 深度编辑 |
| **RPG Maker MZ** | `.rmmzsave` | ✅ 读写 + 深度编辑 |
| **Ren'Py** | `.save` / `.lt1` | ✅ 格式识别 |
| **RPG Maker VX/VX Ace** | `.rvdata2` | ✅ 格式识别 |
| **Wolf RPG Editor** | `.sav` | ✅ 格式识别 |
| **Unity** (常见) | `.dat` / `.sav` | ✅ 格式识别 |
| **Unreal Engine** (常见) | `.sav` | ✅ 格式识别 |
| **Godot** (常见) | `.save` | ✅ 格式识别 |
| **AliceSoft** | `.asd` | ✅ 格式识别 |
| *以及其他 20+ 种格式...* | | ✅ 格式识别 |

## 📦 安装

```bash
npm install
```

## 🚀 使用

### 基本信息识别

```bash
node analyze_save.js info <存档路径>
```

### 完整分析（RPG Maker 系列）

```bash
node analyze_save.js full <存档路径> [游戏数据目录]
```

### 修改命令

| 命令 | 参数 | 说明 |
|------|------|------|
| `gold` | `<存档路径> <金额>` | 修改金钱 |
| `param` | `<存档路径> <角色索引0-7> <数值>` | 修改角色参数 |
| `set` | `<存档路径> <点号路径> <值>` | 修改任意路径 |
| `additem` | `<存档路径> <物品ID> [数量]` | 添加物品 |

> 所有修改命令均自动创建 `.rpgsave.bak` 备份文件。

## 🧠 示例

```bash
# 查看存档信息
node analyze_save.js info save/file1.rpgsave

# 完整分析（含角色/物品/变量/开关）
node analyze_save.js full save/file1.rpgsave www/data

# 改金币
node analyze_save.js gold save/file1.rpgsave 999999

# 添加物品
node analyze_save.js additem save/file1.rpgsave 15 3
```

## 🧩 技术细节

### RPG Maker MV
- LZ-String Base64 压缩 JSON
- 部分游戏使用双重压缩：LZ-String → Base64 → zlib → JSON

### RPG Maker MZ
- zlib 压缩 + UTF-8 文本存储（非 LZ-String！）
- 需通过 Latin-1 反编码恢复二进制后进行 zlib 解压

## 📄 许可

MIT

---

> 个人自用项目，随缘更新。遇到不支持的格式欢迎提 Issue。
