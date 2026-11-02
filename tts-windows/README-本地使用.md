# Breeze TTS 2 本地使用

本目录使用社区 Windows 运行时 **Breeze-TTS-2.cpp v0.1.3**，提供 **F16** 和 **Q8_0** 两个模型，默认 F16。支持中英文语音生成、声音设计和参考音频克隆。

## 启动和停止

1. 模型下载完成后，双击 `Start-F16.cmd` 启动 F16，或双击 `Start-Q8.cmd` 启动 Q8_0。`Start-Breeze.cmd` 按配置启动，默认 F16。加载和预热成功后会自动打开 <http://127.0.0.1:8080/>。
2. 在网页的声音设计页面输入文字和声音描述，生成并试听音频。克隆声音需要参考音频及其准确文字稿。
3. 用完双击 `Stop-Breeze.cmd` 释放显存。关闭网页不会停止后台模型服务。

切换模型时直接双击另一个模型的启动入口。脚本会核实本项目进程身份、停止当前模型，再加载所选模型；两个模型不会同时加载。切换会中断当前生成，请等当前音频完成后再切换。重复点击当前模型会打开已有服务。

F16 文件约 6.28 GB，属于未量化版本；Q8_0 文件约 3.57 GB，显存占用更低。两者功能相同，实际速度以本机生成结果为准。

网页已完整汉化，F16 与 Q8 启动入口均打开同一个中文界面。服务只监听本机，网页及兼容 API 端口为 **8080**，WebSocket 端口为 **8081**，内部语音服务端口为 **8082**。启动等待上限为 120 秒；失败时查看 `logs` 中最新日志。若超时后进程仍在运行，可用停止入口关闭后重试。

启动时不打开浏览器：在本目录的 PowerShell 中执行 `./Start-F16.cmd -NoBrowser` 或 `./Start-Q8.cmd -NoBrowser`。也可执行 `./start-breeze.ps1 -Model F16 -NoBrowser`（`-Model Q8` 选择 Q8_0）。

## 模型和文件

- `config.json`：`model` 字段指定 `models` 目录内的模型文件名或相对路径，默认 `breeze-tts-2-f16.gguf`。换模型后需要停止并重新启动。
- `models`：完整 GGUF 模型文件。下载尚未结束的文件不能启动。
- `runtime`：Windows 运行时；只保留一个 `breeze-server.exe`，否则启动入口会提示冲突。
- `voices`：网页保存的声音。停止服务不会删除它们。
- `outputs`：本地测试音频。网页点击下载的文件会进入浏览器默认下载目录。
- `logs`：运行日志和 `server.pid`。停止入口只有在 PID、程序路径和进程创建时间均匹配时才停止进程。
- `webui-zh`：中文网页资源；`ui_server.py` 为中文页面提供服务并转发语音 API。切换模型时网页服务继续运行，停止入口会同时关闭网页和语音服务。
- `webui-original`：从 v0.1.3 保存的原始网页资源，便于以后更新对照。汉化前的启动脚本保存在 `backups/before-chinese-ui`。

## 来源

- [官方模型和推理项目](https://github.com/breezeblue-ai/breeze-tts)
- [Windows 社区运行时](https://github.com/HoppouAI/Breeze-TTS-2.cpp/releases/tag/v0.1.3)
- [GGUF 模型](https://huggingface.co/HoppouAI/Breeze-TTS-2.cpp)

模型权重与本地生成的音频受 BreezeBlue 研究及非商业许可约束；源代码使用 Apache 2.0 许可。

## 本机验收结果（2026-10-25）

两份模型均通过发布方 SHA256 校验，F16 → Q8 → F16 切换通过。网页与健康检查均返回成功，使用 RTX 4070 Ti SUPER 的 Vulkan 后端。验收后保持 F16 运行。

相同中文文本、声音描述、seed=42、CFG=4 的单次测试：

| 模型 | 音频时长 | 整个生成请求耗时 | 收到首个 4096 字节 |
| --- | --- | --- | --- |
| F16 | 7.44 秒 | 3.642 秒 | 0.209 秒 |
| Q8_0 | 7.36 秒 | 3.832 秒 | 0.229 秒 |

这是一次短文本实测，不代表所有文本的速度。试听文件在 `outputs/中文试听-f16.wav` 和 `outputs/中文试听-q8.wav`，均为 24 kHz 单声道。完整测量记录在 `logs/verification-f16.json` 与 `logs/verification-q8.json`。
