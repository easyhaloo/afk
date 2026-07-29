# TUI Loading 动画实现调研

## Context

AFK 的启动 splash screen 在加载结束时存在抖动问题，进度条在接近 100% 时不平滑。

## 核心发现

### 1. Ink 官方 useAnimation Hook（最相关）

Ink 提供了官方的 useAnimation hook，是驱动动画的推荐方式：

```typescript
const { frame, time, delta, reset } = useAnimation({ interval: 80 });
// frame: 每 interval 递增的计数器
// time:  启动后总耗时 ms（用于 math-based 动画）
// delta: 上一帧时间差 ms
// reset: 重置函数
```

优势：所有动画组件共享同一个内部定时器，多个动画合并为一次渲染循环。

```typescript
// Spinner
const { frame } = useAnimation({ interval: 80 });
const characters = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
return <Text>{characters[frame % characters.length]}</Text>;

// 进度条（基于时间）
const { time } = useAnimation({ interval: 50 });
const progress = (time / 3000) % 1;
```

参考：https://github.com/vadimdemedes/ink/blob/master/_autodocs/api-reference/useAnimation.md

### 2. Ratatui — 帧计数器驱动

```rust
loop {
    terminal.draw(|frame| {
        let t = frame.count() as f64;
        let progress = (t / 60.0).min(1.0);
        // render gauge
    });
}
```

### 3. 主流 CLI 工具

| 工具 | 平滑技术 |
|------|---------|
| npm | 无插值，固定刷帧 |
| yarn | 百分比直接跳变 |
| docker | 无动画 |

### 4. 平滑技术模式

| 技术 | 公式 | 场景 |
|------|------|------|
| lerp | v = lerp(v, t, 0.12) | 通用，末端振荡 |
| Snap | diff < ε → v = t | 消除抖动 |
| easeOut | 1 - (1-t)³ | 渐入/渐出 |
| easeInOut | t<0.5 ? 2t² : ... | 更自然 |
| 时间基 | progress = elapsed/total | 真实时间 |

### 5. 过渡技术

| 方案 | 效果 |
|------|------|
| opacity fade | 柔和 |
| 向上滑出 | 干净 |
| 字符雨淡出 | 科技感 |
| 直接替换 | 生硬 |

## 对 AFK 的启示

### 当前问题
- 手动 setInterval → 与 Ink 渲染竞争
- 固定 LERP_FACTOR → 末端振荡
- fadeOut 冻结 frame → 硬截断

### 建议方案

1. **替换为 useAnimation** — 官方共享定时器，无竞争
2. **基于时间的进度计算** — 用 time 而非 frameRef 同步追赶
3. **Snap + easeOut 组合** — 消除抖动 + 柔和曲线
4. **fadeOut 后继续动画** — 用 easeOut 让过渡柔和

## Open Questions

1. useAnimation 的 delta 在组件卸载后是否重置？
2. 多个 useAnimation 是否真的共享定时器？
3. 6 个阶段各有不同 fetch 时间，如何映射到线性时间？

## References

- Ink useAnimation: github.com/vadimdemedes/ink/.../useAnimation.md
- Ratatui: docs.rs/ratatui/latest/ratatui/widgets/struct.LineGauge.html
