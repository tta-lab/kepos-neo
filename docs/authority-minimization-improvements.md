# Kepos Neo 中间人权限最小化改进讨论

状态：讨论稿
日期：2026-07-17

## 1. 目的

本文记录 Kepos Neo 从当前 MLP 信任模型走向“中间人权限最小化”还需要验证的缺口和候选改进。

本文不是实施计划，也不改变
[MLP decisions](./mlp-decisions.md) 中已经接受的 V0、V1 和 V2 范围。每项改进都必须先由真实风险或使用证据触发，不能因为密码学模型看起来更完整就自动进入 MLP。

价值与产品定位单独记录在
[Kepos Neo 中间人权限最小化的产品价值](./authority-minimized-network-value.md)。

## 2. 要守住的安全不变量

后续设计无论更换身份层、relay 或 carrier，都应保持以下不变量：

1. publisher 本地状态是服务授权的最终事实；
2. bootstrap、DHT、relay 和观测系统不能增加成员；
3. relay 不能取得 endpoint secret 或服务明文；
4. 远端不能选择 publisher 未明确配置的 target；
5. client 必须固定并验证 publisher identity；
6. carrier 从 direct UDP 切换到 relay UDP、TCP/TLS 或 WSS 时，peer authorization 不变；
7. 空、缺失或损坏的授权状态必须 fail closed；
8. 软件更新不能绕过 endpoint 所持有的身份和授权边界。

最后一项不能只靠网络协议保证。能向 endpoint 发布恶意代码的更新系统，事实上拥有读取私钥和改变授权逻辑的最高权限。

## 3. 威胁模型

### 3.1 需要防止的中间人能力

- 在初次 pairing 时替换 `clientKey` 或 `homeKey`；
- 通过控制 DHT 或 relay 冒充 publisher 或 client；
- 在不修改 publisher 本地状态的情况下授予服务访问；
- 让已授权 peer 访问未发布的 host 或 port；
- 从 relay 获取 endpoint secret 或服务明文；
- 通过 Registry 注入不属于 pinned Home 的 service；
- 通过自动更新向 endpoint 注入窃取 key 的代码；
- 把不同关系中的同一个 client identity 关联起来。

### 3.2 暂不试图消除的能力

- DHT、relay 和 ISP 观察 IP、时间、包大小和流量；
- 恶意基础设施拒绝服务、延迟或丢弃流量；
- direct P2P peer 看到对方的公网 endpoint；
- publisher 自己读取它明确提供的本地服务数据；
- 已获授权的 client 按应用协议读取其被允许的数据；
- endpoint 操作系统或本地管理员窃取本机 secret。

权限最小化不等于匿名网络，也不等于防御已被完全控制的 endpoint。

## 4. 当前模型已经具备的基础

当前 MLP 设计已有正确的最小基础：

- `clientKey` 证明连接 client 持有对应 secret；
- `homeKey` 是 client 带外固定的 publisher trust anchor；
- service key 通过已经认证的 Home Registry 学习；
- publisher-local allowlist 决定是否接受 client；
- 每个 publisher 的 trust 是单向且独立的；
- service target 只来自 publisher 本地配置；
- Home 和远端 service 只通过本地 loopback endpoint 暴露给 client 应用；
- relay admission 与 publisher service authorization 明确分开；
- MLP 不安装 TUN，不默认扩大到整机或子网；
- 缺失或 malformed allowlist 不应被解释为 allow-all。

改进应建立在这些边界上，而不是为了增加功能重新引入一个全局授权 controller。

## 5. 改进一：可靠的初次 pairing

### 问题

Noise 可以证明连接者持有某个 key，但不能证明用户第一次收到的 key 没有被中间通信平台替换。

如果 `clientPublicKey` 和 `homePublicKey` 只通过一个可被控制的聊天渠道交换，攻击者可以分别与两端建立合法加密连接。

### 候选改进

按复杂度从低到高：

1. 展示短指纹，要求双方通过第二渠道人工核对；
2. 当面扫描包含完整 key 和协议版本的 QR；
3. 生成双方都可见的短认证字符串；
4. 未来由 Person root 签名 device 或 Home key。

### 建议

MLP 后第一个实际改进应是 QR 加短指纹核对。不要先建设全局身份目录。

### 验证门槛

- 用户能分辨“收到 key”和“已经核对 key”；
- pairing 记录保留验证方式和时间；
- 未核对关系在 UI 中有明确状态；
- 替换 QR 内容或 key 后连接必须失败或要求重新确认。

## 6. 改进二：从 publisher-wide allowlist 收窄权限

### 问题

当前一个受信 peer 可以访问该 publisher 明确发布的所有服务。对稳定家庭可能可接受，但对游戏好友、临时协作者或高风险管理服务过宽。

### 三种候选

#### 方案 A：每服务 allowlist

每个 service 保存自己的 peer-key 集合。

优点：简单、直观、仍以 publisher 本地状态为 SSOT。  
缺点：服务多时重复配置，关系变更需要批量更新。

#### 方案 B：本地 group 加每服务引用

Publisher 本地定义 `family`、`friends` 等 group，service 引用 group 或 peer。

优点：减少重复，仍不需要中心 controller。  
缺点：开始形成本地 RBAC，需要控制范围。

#### 方案 C：签名 capability grant

Owner 为 peer 签发带 service、权限、有效期和 session ID 的 grant，publisher 在连接时验证。

优点：适合邀请、临时 session 和离线传递。  
缺点：撤销、时钟、重放、续期和密钥轮换明显更复杂。

### 建议

先采用方案 A 验证真实需求。如果多个服务反复出现相同配置，再引入本地 group。只有 named session 和跨设备 owner workflow 被证明后，才设计签名 capability。

不要为了“更去中心化”直接跳到一套复杂 token 协议。

## 7. 改进三：Pairwise identity 降低跨关系关联

### 问题

如果一个 client 在不同 publisher 关系中重复使用同一个长期 `clientKey`，多个 publisher 可以确认它们见到的是同一个设备。DHT 或其他观测者也可能利用稳定 key 和流量进行关联。

### 候选模型

```text
Person root
  ├─ relationship key for Alice
  ├─ relationship key for Bob
  └─ relationship key for Carol
```

每段关系使用独立 peer key。Person root 只在需要证明多设备或 key 轮换时签名，不直接作为每次网络连接的公开 identity。

### 代价

- key 数量增加；
- 多设备同步和备份更复杂；
- publisher 无法天然判断两个 relationship key 属于同一个人；
- root 丢失和轮换需要恢复设计。

### 触发条件

在以下证据出现前保持当前 persistent peer key：

- 用户明确不希望不同朋友关联同一设备；
- 一个 Person 需要多设备且不想逐个重新 pairing；
- Home key 轮换要求保留 Person continuity；
- session grant 需要稳定的签名身份。

## 8. 改进四：动态撤销和现有 session 关闭

### 问题

MLP 允许修改 allowlist 后重启 daemon 生效。这能验证 fail-closed 授权，但不是理想的长期操作模型。

### 候选改进

- publisher 原子加载新授权快照；
- 删除 peer 后立即拒绝新连接；
- 可选地关闭该 peer 的现有 session；
- 每次 session 建立时记录使用的授权版本；
- 日志明确区分 `revoked`、`not_allowed` 和 `session_expired`；
- 多服务进程必须从同一个 publisher-local 授权源读取一致快照。

撤销不应依赖 relay 或 DHT 在线确认。它们可以传播提示，但 publisher 本地状态必须独立生效。

## 9. 改进五：非托管 blind relay

### 必须满足

- relay 不接收 peer 或 service secret；
- peer 之间保持端到端 Noise；
- relay admission 与 service authorization 使用不同数据；
- relay allowlist 只能控制谁可消耗 relay 带宽；
- relay 不能修改 Home Registry；
- relay 不能选择或重写 local target；
- 有连接数、带宽、字节、队列和 idle timeout 限制；
- relay 重启只导致可用性失败，不导致降级为明文或重新授权。

### 需要验证

- hard NAT pair 是否能稳定使用 `relayThrough`；
- relay 能否在不知道业务协议的情况下正确处理 backpressure；
- abuse control 是否能在认证前限制资源消耗；
- operator 能否区分 punch failure、relay rejection 和 publisher rejection；
- relay compromise 后实际暴露哪些 metadata。

当前 Holepunch blind relay 仍依赖 UDP。它不能解决 UDP 被完全阻断或严重整形的网络。

## 10. 改进六：保持端到端 Noise 的 TCP/TLS 或 WSS fallback

### 问题

国内跨运营商、移动、校园、酒店和企业网络可能允许 TCP/443，但阻断或严重限制 UDP。

### 安全边界

```text
client endpoint
  -> inner end-to-end Noise
  -> outer TLS/WSS relay carrier
  -> inner Noise terminates at publisher endpoint
```

Outer TLS 只保护 endpoint 到 gateway 的一跳。真正的 peer identity 和服务机密仍由 inner Noise 保护。

任何要求 endpoint 把 secret key 交给 gateway 的 custodial 模式都不应使用。

### 设计要求

- trust、Registry 和 tunnel protocol 不依赖 Hyperswarm 内部对象；
- direct、UDP relay 和 TCP relay 使用相同 publisher authorization；
- relay 只看 opaque encrypted frames；
- 支持 `auto`、`direct-only` 和 `relay-only` 诊断模式；
- path selection 根据持续质量，而不只是首次连接成功；
- carrier 切换不能静默降低认证或加密强度。

## 11. 改进七：明确 metadata 与 IP 隐私选项

Direct P2P 会让双方看到彼此公网 endpoint。这不是 relay 中间人权限问题，但可能不符合某些用户的隐私预期。

长期可以提供：

- `direct-only`：最少 relay metadata，peer 互相看到 IP；
- `auto`：优先健康 direct，必要时 relay；
- `relay-only`：隐藏 peer 之间的公网 endpoint，但 relay 看到双方 metadata。

产品必须解释这个取舍。不能同时承诺 direct P2P、隐藏双方 IP、无 relay 和低延迟。

## 12. 改进八：软件供应链和更新权限

自动更新是最容易被忽视的高权限中间人。只要更新系统能替换 endpoint 程序，它就可能读取所有本地 secret。

需要逐步建立：

- 固定并可轮换的发布签名 key；
- endpoint 在执行前验证更新签名；
- 更新 metadata 防回滚；
- 发布 key 与日常构建、托管权限分离；
- 密钥轮换有离线恢复路径；
- 记录依赖版本和来源；
- 对复制或 fork 的上游代码保留许可证与来源；
- 评估可复现构建或公开透明日志。

在这些边界建立前，不应声称中间基础设施完全没有提权路径。

## 13. 改进九：本地入口和 HTTPS 边界

当前 `*.kepos.localhost` 和 loopback gateway 符合最小权限方向：

- 不修改系统 DNS；
- 不安装 TUN；
- 不要求公共 CA 参与 peer authorization；
- 不把远端服务直接绑定到 LAN；
- 浏览器只连接本机 endpoint。

仍需验证：

- 不同 `*.localhost` service 的 Origin、Cookie、CORS 和 CSP 行为；
- OAuth callback 和 absolute redirect 是否兼容；
- 本机其他用户或恶意进程是否能连接已打开的 loopback port；
- gateway 是否需要短期 bearer、随机端口或 OS user 边界；
- 哪些 Web API 必须使用受信 HTTPS origin；
- 是否能继续避免安装一个拥有全局签发权的本地 CA。

mTLS 不是默认答案。Kepos 已在 peer transport 层使用 Noise 做双向 key 认证。只有应用协议明确需要 X.509 client certificate 时，才应增加 mTLS。

## 14. 改进十：验证与可观测性

安全声明必须能由测试和运行状态证明。

至少需要覆盖：

- 未知 client 不能访问 Home 或 service；
- Registry 不匹配 pinned Home 时拒绝；
- 远端无法指定未发布 target；
- 空或损坏授权状态 fail closed；
- 删除 peer 后新连接立即失败；
- 配置要求关闭现有 session 时，session 确实终止；
- direct、UDP relay 和 TCP relay 保持同一 peer identity；
- relay 无法读取 payload 或构造有效 service 请求；
- 日志、命令行和崩溃报告不包含 seed 或 secret；
- 不同 relationship key 不被应用层意外合并；
- 软件更新签名错误、过期或回滚时拒绝安装。

运行状态应区分：

```text
bootstrap_unreachable
discovery_failed
punch_failed
udp_unavailable
relay_rejected
publisher_not_allowed
service_not_published
session_revoked
```

把所有失败都显示为“连接超时”会迫使用户修改网络或信任错误的中间设施。

## 15. 建议验证顺序

以下顺序是讨论建议，不是已接受 roadmap：

1. 保持当前静态 allowlist，完成真实 direct P2P 与 one-to-many 价值验证；
2. 加入 QR 和短指纹，封住首次 pairing MITM；
3. 用每服务 allowlist 验证权限是否确实需要收窄；
4. 支持授权热加载和明确的 session revoke；
5. 验证有配额的非托管 UDP blind relay；
6. 用国内和受限网络矩阵决定是否建设 TCP/TLS 或 WSS relay；
7. 在多设备、关联隐私或 key 轮换需求出现后再引入 Person root 和 pairwise key；
8. 在自动更新成为产品路径前完成更新签名和防回滚边界；
9. 只有临时邀请和 named session 被用户证明后，再设计 signed capability。

## 16. 明确不做

- 不把 bootstrap 或 relay 变成授权数据库；
- 不为追求完整模型提前建设中心账号系统；
- 不默认创建虚拟网卡或暴露整个子网；
- 不把 DHT announcement 当作授权证明；
- 不使用会把 endpoint secret 交给 relay 的 custodial fallback；
- 不因为使用 TLS/443 就把 gateway 当成可信 endpoint；
- 不把静态 peer key 包装成已经解决的 Person identity；
- 不在缺少真实需求时建设完整 RBAC、PKI 或 capability language。
