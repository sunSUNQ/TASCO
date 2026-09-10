# Code Guard 工作流引导（由插件按任务注入）

## 高效执行路径
- 先 repo_map.py 拿结构,再精确读:read_file_slice.py 小切片 / smart_read_file.py 定向读。
- 不要宽泛目录枚举或全仓搜索;搜索用精确符号/文件名,一次定位。
- 实现类:证据齐备后用原生 write/edit 一次写完整目标文件,立即 node --test,按失败信息小改一次。
- 被压缩的 read/grep 输出不要顺序补读,改用精确搜索/切片。
