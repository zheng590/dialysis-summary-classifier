# 透析小结分类工作台

本项目用于辅助整理透析小结，不用于诊断或治疗决策。所有分类结果均需人工复核。规则模式仅为演示，无法可靠识别所有语义、否定和临床情况。

## 启动

在项目目录打开 PowerShell，运行：

```powershell
python server.py
```

打开 http://127.0.0.1:8000/。默认规则模式无需密钥。CSV 可直接导入；XLSX 导入需要 `python -m pip install openpyxl`。系统仅读取 XLSX 活动工作表，第一行须为不重复的表头。

## 在线 Jev

OpenRouter 需要账号和 API 密钥，调用可能收费。密钥只保存在启动服务的环境变量中，不要提交到代码或分享给他人。在 PowerShell 中设置后启动：

```powershell
$env:OPENROUTER_API_KEY = '在本机填写你的密钥'
python server.py
```

网页选择“在线 Jev”。默认模型为 `typesafe/jev-1.14`，可用环境变量 `JEV_MODEL` 修改。在线调用会把小结内容发送给第三方服务。处理患者数据前请先脱敏，并确认机构许可、第三方数据条款及跨境传输要求。未设置密钥时不会自动退回其他模式。

## 本地模型

启动提供 OpenAI 兼容 `/v1/chat/completions` 接口的本机服务，然后设置：

```powershell
$env:LOCAL_MODEL_BASE_URL = 'http://127.0.0.1:1234/v1'
$env:LOCAL_MODEL_NAME = '本地模型名称'
python server.py
```

如本机服务需要鉴权，可设置 `LOCAL_MODEL_API_KEY`。出于数据安全考虑，地址限定本机回环地址。此接口面向 OpenAI 兼容生成模型，不代表已经提供本地 Jev 模型。

## 分类与验证

支持一条小结对应多个分类；原始提示词“头晕M出汗”暂按“头晕”和“出汗”两个类别处理，请结合业务口径确认。无法识别的内容显示“未分类”，不表示患者没有不适。样例 1 仅描述下肢疼痛，没有明确痉挛证据，规则模式不推断痉挛；样例 2 的规则演示返回高血压和头痛。规则模式使用固定阈值辅助识别血压，不能替代具体临床标准和人工审核。

运行自动化测试：

```powershell
python -m unittest -v test_server
```
