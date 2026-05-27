---
name: save-editor
description: 通用存档分析/编辑工具。支持 RPG Maker MV/MZ/Ren'Py/Unity/Unreal/Godot 等数十种引擎的格式识别和基本信息提取。深度编辑支持 RPG Maker 系列。
argument-hint: <存档路径>
when_to_use: 当用户需要分析、查看或修改游戏存档文件时使用。支持 .rpgsave/.save/.dat/.sav/.json/.rmmzsave 等多种格式，自动识别引擎类型。
user-invocable: true
---

# 存档编辑器

## 用法
```
/save-editor <存档路径>
```

## 工作流

1. `node <skill_dir>/analyze_save.js info <存档>` — 格式识别 + 基本信息
   - 自动检测引擎（RPG Maker / Ren'Py / Unity / Unreal / Godot 等 30+ 格式）
   - 自动解压容器（ZIP / GZip / Brotli / LZ-String 等）
2. `node <skill_dir>/analyze_save.js full <存档> [游戏数据目录]` — 完整分析
   - RPG Maker：解析角色/物品/变量（按类别汇总）/开关
3. 想看详情：说 **"展开变量"** 或 **"展开开关"**

## 修改命令 (RPG Maker only)
| 命令 | 用途 |
|------|------|
| `gold <存档> <金额>` | 改金钱 |
| `param <存档> <0-7> <值>` | 改角色参数 |
| `set <存档> <点号路径> <值>` | 改任意路径 |
| `additem <存档> <ID> [数量]` | 添加物品 |

修改自动备份为 `.rpgsave.bak`。
