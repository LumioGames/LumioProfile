---
name: profile-101-game-validation-2026-10-16
description: LumioProfile在真实101游戏中可选接入、跨端关联、导出和开销的本机验证摘要
metadata:
  type: evidence
  status: recorded
---

# 真实101游戏验证

本次外部接入由用户明确授权，工具目录统一改为LumioProfile，包名/协议不变。没有修改采集器性能逻辑。此前合成宿主验证保持原口径；本轮使用当前项目内的LumioEngine和LumioGameNext真实游戏，不是工具demo。

结论为**受限可行**。已完成真实solo三上下文、独立Node DS六上下文、原生Chrome/Edge独立进程、短窗CLI全链及官方Perfetto v58.2查询。最终v2采集 `3deaa46c-a379-434b-b430-4c449f01c657` 六来源零缺失/丢弃/覆盖/invalid，并能查5条输入序号→动作→GAS→实际炸弹实体→双端WebGL提交。技能缓冲与执行分开，同钟约150ms过期缓冲不当成GAS CPU。

无插件普通构建、默认Off、Stats实际聚合、停止导出释放、有界丢新均取得真实游戏证据。v1八轮、v2五轮固定12秒输入对照已执行；基线波动、起始tick/业务交互差异、短样本及CPU未测使严格预算仍为证据不足。全marker长窗填满8MiB并丢新，完整覆盖未通过，未用较低写入成本冒称预算达标。

固定来源计划不能自动加入晚注册或替换Worker；真实TCP重连包保留缺源。每实例四场会话、CLI无markerIds参数、统一目录校验等当前限制均如实记录。没有把Unity/PuerTS、远程生产DS、GPU或物理屏幕呈现扩展为已验证范围。

权威报告位于本地项目 `C:\Users\g923\.codex\.chatgpt-projects\g-p-6ace45afd69c8191836b24858a8967a5\验证\lumio-profile-101\README.md`，其中包含分报告、原始包冻结、源码SHA-256、配置、失败样本与可重跑SQL。工具无Git提交/远端，以归档源码及产物摘要定位本轮版本。原始资料未上传。
