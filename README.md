# Asset Manager

统一素材管理工具，支持增量扫描、MD5 去重、自动分类图片和视频、视频截帧。

## 目录结构

```
asset_manager/
├── organizer.py          # 主工具（命令行）
├── hash_cache.db         # SQLite 哈希缓存（自动生成，gitignore）
├── images/               # 整理后的图片（symlink）
│   ├── clothoff_naked/
│   ├── jason_photo/
│   └── ...
├── videos/               # 整理后的视频（symlink）
│   ├── spicy_adult/
│   ├── fapify_trimmed/   # 实际文件（剪掉前1秒）
│   └── ...
├── scripts/              # 辅助脚本（批量编辑/生成等）
├── legacy/               # 旧版一次性脚本（归档）
├── video-frame-extractor/ # 视频截帧 Web UI（Node.js）
└── *.md / *.json         # 提示词、姿势参考、工作流配置
```

## 快速使用

### 添加新数据源

```bash
# 自动识别图片/视频
python3 organizer.py add 分类名 /path/to/data --type auto --recursive

# 指定类型
python3 organizer.py add new_photos /data/pics --type image
python3 organizer.py add new_videos /data/vids --type video --recursive
```

### 查看状态

```bash
python3 organizer.py status
python3 organizer.py list-sources
```

### 重新扫描所有已注册源（增量，只算变化的文件）

```bash
python3 organizer.py scan
```

### 从视频分类抽帧

```bash
# 在第4秒截帧，输出到 images/<分类名>_frames_4s/
python3 organizer.py extract-frames spicy_adult --at 4
```

## 缓存机制

- `hash_cache.db` 存储所有已计算过 MD5 的文件信息（路径 + size + mtime + md5）
- 文件未修改时直接读缓存，**零 I/O**
- 只有新增或修改的文件才重新计算 MD5
- 去重是全局的：新源文件会与所有历史哈希比对

## 注意事项

- symlink 指向原始文件，不占额外空间
- `fapify_trimmed/` 是实际复制文件（ffmpeg 剪掉前1秒）
- 删除 `hash_cache.db` 后首次运行会重新计算所有哈希（约10分钟）
