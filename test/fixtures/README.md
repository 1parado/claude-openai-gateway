# 公开测试证书

`localhost-cert.pem` 和 `localhost-key.pem` 是随源码公开的自签名 TLS 测试夹具。
它们仅由 `test/providers.test.mjs` 使用，用来验证本机 HTTPS 直连和 CONNECT 代理；模拟服务只监听 `127.0.0.1`。

私钥不代表任何生产服务或真实账户。不要将该证书和私钥用于生产环境，也不要将测试证书导入系统信任库。测试仅通过子进程的 `NODE_EXTRA_CA_CERTS` 临时信任它。
