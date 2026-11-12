#!/usr/bin/env python3
# Vendored 纯 python Ed25519（RFC 8032，hashlib 单依赖——mcp/taskboard 零依赖约束的
# 唯一签名路径，exposure-crypto-trust 报告 §4.4 路线三）。
#
# 出处与正确性锚点：按 RFC 8032 标准公式实现（射影坐标 Edwards25519，迭代 double-and-add）；
# **正确性由 node:crypto（OpenSSL 独立实现）跨实现互验钉死**（test/board-signing.selftest.mjs：
# python 签名 == node 签名（同 seed 同消息逐字节）、python 验签通过 node 签名、node 验签通过
# python 签名、公钥派生逐字节一致）——独立双实现对不上即测试翻红，不依赖实现者自证。
#
# 边界（如实声明）：
# - 纯大整数实现，性能量级慢于原生（sign ~10ms、verify ~30ms @CPython/arm64，消息小）——
#   事件面量小（每任务个位数事件/日，报告 §4.2 口径），仅在签名/验签配置面存在时付出。
# - 验签严格面：S ≥ l 拒（canonical S，与 OpenSSL 语义对齐）；非曲线点/长度不符拒。
# - 不含 BIP32/EDSA 等扩展；仅 sign/verify/publickey 三面。
import hashlib

B = 256
Q = 2 ** 255 - 19
# 群阶 ℓ（B 的阶，RFC 8032 §5.1）：十进制字面落盘（2^252 加式写法极易抄错尾数——
# 本轮实测：错误尾数使 r/S/k 归约全错、而 pk 路径（不经过 L）仍全绿，双重实现互验
# 才钉出此错；L·B == 单位元是自检锚点，测试覆盖）。
L = 7237005577332262213973186563042994240857116359379907606001950938285454250989


def _H(m):
    return hashlib.sha512(m).digest()


def _inv(x):
    return pow(x, Q - 2, Q)


D = -121665 * _inv(121666)
_I = pow(2, (Q - 1) // 4, Q)
_IDENT = (0, 1, 1, 0)  # 射影中性点 (X=0, Y=1, Z=1, T=0)


def _xrecover(y):
    xx = (y * y - 1) * _inv(D * y * y + 1)
    x = pow(xx, (Q + 3) // 8, Q)
    if (x * x - xx) % Q != 0:
        x = (x * _I) % Q
    if (x * x - xx) % Q != 0:
        raise ValueError('点不在曲线上（平方根恢复失败）')
    if x % 2 != 0:  # 奇偶归一（RFC 8032「positive」=偶根；B 常量为偶根）
        x = Q - x
    return x


_BY = 4 * _inv(5) % Q
_BX = _xrecover(_BY)
_BASE = (_BX % Q, _BY % Q, 1, _BX * _BY % Q)


def _edwards_add(P, Qp):
    """射影扩展坐标 (X:Y:Z:T) 的 Edwards 加法。"""
    x1, y1, z1, t1 = P
    x2, y2, z2, t2 = Qp
    a = (y1 - x1) * (y2 - x2) % Q
    bb = (y1 + x1) * (y2 + x2) % Q
    c = t1 * 2 * D * t2 % Q
    dd = z1 * 2 * z2 % Q
    e = bb - a
    f = dd - c
    g = dd + c
    h = bb + a
    return (e * f % Q, g * h % Q, f * g % Q, e * h % Q)


def _scalarmult(P, e):
    """迭代 double-and-add（无递归——标量 253 位不触 Python 递归上限）。"""
    r = _IDENT
    while e > 0:
        if e & 1:
            r = _edwards_add(r, P)
        P = _edwards_add(P, P)
        e >>= 1
    return r


def _encodepoint(P):
    """点编码：z 归一化后 y 的 255 位小端 + x 最低位作最高符号位（RFC 8032 §5.1.2）。"""
    x, y, z, _t = P
    zi = _inv(z)
    x = x * zi % Q
    y = y * zi % Q
    return ((y | ((x & 1) << 255))).to_bytes(32, 'little')


def _decodepoint(s):
    if len(s) != 32:
        raise ValueError('点编码长度须 32 字节')
    y = int.from_bytes(s, 'little') & ((1 << 255) - 1)
    sign = (s[31] >> 7) & 1
    x = _xrecover(y)
    if x & 1 != sign:
        x = Q - x
    P = (x, y, 1, x * y % Q)
    _assert_on_curve(P)
    return P


def _assert_on_curve(P):
    x, y, z, t = P
    if z % Q == 0:
        raise ValueError('点 Z 坐标为零')
    if x * y % Q != z * t % Q or (y * y - x * x - z * z - D * t * t) % Q != 0:
        raise ValueError('点不在曲线上')


def _clamp_scalar(seed):
    """RFC 8032 私有标量：sha512(seed) 前半的 bit3..bit253 + bit254 置位（bit0-2/255 清零）。"""
    h = _H(seed)
    a = 1 << 254
    for i in range(3, 254):
        if (h[i // 8] >> (i % 8)) & 1:
            a += 1 << i
    return a


def publickey(seed):
    """公钥派生：32 字节 seed → 32 字节公钥（编码后的 a·B）。"""
    if len(seed) != 32:
        raise ValueError('seed 须 32 字节')
    return _encodepoint(_scalarmult(_BASE, _clamp_scalar(seed)))


def signature(m, seed, pk):
    """Ed25519 签名（RFC 8032 §5.1.6）：64 字节 = R 编码 || S 小端 32 字节。"""
    if len(seed) != 32 or len(pk) != 32:
        raise ValueError('seed/pk 须 32 字节')
    a = _clamp_scalar(seed)
    h = _H(seed)
    r = int.from_bytes(_H(h[32:] + m), 'little') % L
    r_point = _scalarmult(_BASE, r)
    r_enc = _encodepoint(r_point)
    k = int.from_bytes(_H(r_enc + pk + m), 'little') % L
    s = (r + k * a) % L
    return r_enc + s.to_bytes(32, 'little')


def checkvalid(sig, m, pk):
    """验签（严格面）：S 范数拒（≥L）、点解码拒、[S]B == R + [k]A 射影等价比对。"""
    if len(sig) != 64:
        raise ValueError('签名长度须 64 字节')
    if len(pk) != 32:
        raise ValueError('公钥长度须 32 字节')
    s = int.from_bytes(sig[32:], 'little')
    if s >= L:
        return False  # 非范数 S（canonical S 语义，与 OpenSSL 严格面对齐）
    r_enc = sig[:32]
    r_point = _decodepoint(r_enc)
    a_point = _decodepoint(pk)
    k = int.from_bytes(_H(r_enc + pk + m), 'little') % L
    lhs = _encodepoint(_scalarmult(_BASE, s))
    rhs = _encodepoint(_edwards_add(r_point, _scalarmult(a_point, k)))
    return lhs == rhs
