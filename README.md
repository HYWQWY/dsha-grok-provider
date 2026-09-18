# dsha-grok-provider

面向 **[DSHA](https://github.com/DSH-APP/DSHA)**（安卓版 DeepSeek Harness）的 **Grok (xAI) 订阅** 大模型供应商插件。

用已有的 X Premium / Premium+ / SuperGrok 订阅登录，**不需要 API Key**。仅自用。

> 功能实现基于 MIT 开源项目 [`xuediner-source/dsh-grok-sub`](https://github.com/xuediner-source/dsh-grok-sub) 整理；本仓库针对 **DSHA 安卓端插件解析/安装** 做了清单与包结构清理（例如去掉 `package.json` UTF-8 BOM、统一包名与 bundle id），避免社区原包在 DSHA 里无法安装。

## 在 DSHA 里安装

1. 打开 DSHA → **插件市场**
2. 粘贴下面任一来源后点安装：
   - `HYWQWY/dsha-grok-provider`
   - `https://github.com/HYWQWY/dsha-grok-provider`
3. 安装成功后回到 **启动页**，**重启 Web** 才会生效
4. 在 Web 的 **设置 → 订阅中心（Subscriptions）** 登录 Grok

若 GitHub 下载受限：在电脑上把本仓库打成 zip，用 DSHA 的 **导入插件包** 安装。

## 能力概览

| 能力 | 说明 |
|---|---|
| OAuth 登录 | xAI 官方 OIDC（`auth.x.ai`），无需手填 Key |
| 令牌刷新 | 到期前自动刷新 |
| 模型发现 | 查询官方模型列表，失败时回退内置目录 |
| 推理强度 | `xhigh` / `high` / `medium` / `low` |
| 工具 | `x_search`、`image_generate`、`video_generate` |

## 凭据

登录态保存在 DSHA/dsh 数据目录下的 `plugins/subscriptions/auth.json`（本机私有），不会上传到本仓库。

## 许可

MIT。上游实现版权归 [`xuediner-source`](https://github.com/xuediner-source/dsh-grok-sub)；本仓库适配与打包修改归仓库所有者。
