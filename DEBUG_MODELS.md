# 模型选择器调试指南

## 问题描述
用户反馈：页面对话中，自定义的 3 个模型只能使用默认的一个。

## 调试步骤

### 1. 检查 API 数据（后端）
在终端运行：
```bash
# 检查 /providers API 是否返回正确的数据
curl http://localhost/piweb/api/providers | jq .

# 应该看到：
# - providers 数组中包含 my-provider
# - my-provider 包含 3 个模型
# - current 字段显示当前模型
```

### 2. 检查前端 JavaScript 控制台（浏览器）
在浏览器中打开 http://localhost/piweb/，然后：

1. **打开开发者工具** (F12 或 Cmd+Option+I)
2. **切换到 Console 标签**
3. **运行以下调试脚本**：

```javascript
// 调试脚本 - 复制到控制台运行
(function() {
    console.log('=== 模型选择器调试 ===');
    
    // 1. 检查 Hermes 对象
    console.log('1. window.Hermes 存在:', !!window.Hermes);
    console.log('2. loadProviders 存在:', typeof window.Hermes.loadProviders === 'function');
    console.log('3. switchModel 存在:', typeof window.Hermes.switchModel === 'function');
    
    // 2. 检查当前模型数据
    console.log('4. _modelProviders:', window.Hermes._modelProviders || '未找到');
    console.log('5. _currentModel:', window.Hermes._currentModel || '未找到');
    
    // 3. 手动调用 loadProviders
    console.log('6. 正在调用 loadProviders()...');
    window.Hermes.loadProviders().then(() => {
        console.log('✅ loadProviders() 完成');
        console.log('   新的 _modelProviders:', window.Hermes._modelProviders);
        console.log('   新的 _currentModel:', window.Hermes._currentModel);
        
        // 4. 检查 my-provider 是否在列表中
        const myProvider = window.Hermes._modelProviders?.find(p => p.name === 'my-provider');
        if (myProvider) {
            console.log('✅ 找到了 my-provider:', myProvider);
            console.log('   模型数量:', myProvider.models.length);
            myProvider.models.forEach(m => {
                console.log(`   - ${m.id} (${m.name})`);
            });
        } else {
            console.error('❌ 没有找到 my-provider！');
        }
    }).catch(err => {
        console.error('❌ loadProviders() 失败:', err);
    });
    
    // 5. 检查 DOM 元素
    console.log('7. 检查 DOM 元素:');
    console.log('   provider-trigger:', !!document.getElementById('provider-trigger'));
    console.log('   provider-label:', document.getElementById('provider-label')?.textContent);
    console.log('   ctx-model:', document.getElementById('ctx-model')?.textContent);
    
})();
```

### 3. 检查模型选择器 UI
在浏览器页面上：

1. **点击左下角的模型名称**（或者"对话"标签页中的模型选择器）
2. **应该看到一个浮窗**，列出所有可用的模型
3. **检查是否显示 `my-provider` 分组**，包含 3 个模型：
   - glm-5.2-fp8
   - glm5-cdp
   - hy3-preview

#### 如果看不到 my-provider：
- 可能是 `loadProviders()` 没有被调用
- 或者 API 返回的数据没有正确解析

#### 如果能看到 3 个模型，但是只能点击默认的那个：
- 检查浏览器控制台是否有 JavaScript 错误
- 检查模型项的点击事件是否被阻止

### 4. 测试模型切换
在浏览器控制台运行：

```javascript
// 测试切换到 glm5-cdp
window.Hermes.switchModel('my-provider', 'glm5-cdp').then(() => {
    console.log('切换完成，检查 provider-label:', document.getElementById('provider-label')?.textContent);
});
```

### 5. 检查新建会话是否使用正确的模型
创建一个新会话，然后：

1. 在浏览器控制台运行：
```javascript
// 检查当前会话的模型
console.log('当前会话 ID:', window.Hermes.state.focusedSessionId);
```

2. 发送一条消息，观察 pi-bridge 日志：
```bash
tail -f /tmp/pi-bridge.log
```

应该看到类似这样的日志：
```
[pi-bridge] prompt start: ... | model: glm5-cdp
```

### 6. 可能的问题和解决方案

#### 问题 A：`loadProviders()` 没有被调用
**症状**：`_modelProviders` 是空数组或者不包含 `my-provider`

**解决**：
1. 检查 `app.js` 中的初始化流程
2. 确保在 `DOMContentLoaded` 事件中调用了 `loadProviders()`

#### 问题 B：模型切换后 UI 没有更新
**症状**：`_currentModel` 更新了，但是 UI 还显示旧的模型名

**解决**：
1. 检查 `switchModel()` 函数是否正确更新了 `provider-label` 和 `ctxModel`
2. 检查是否有其他地方覆盖了这些值

#### 问题 C：新建会话使用了错误的模型
**症状**：切换模型后，新建的会话还是使用旧模型

**解决**：
1. 这是正常行为！切换模型只影响之后的新会话
2. 已有的会话不会自动切换模型（需要手动调用 `session.setModel()`）

#### 问题 D：模型项不可点击
**症状**：模型列表中的项看起来是正常的，但是点击没有反应

**解决**：
1. 检查是否有 JavaScript 错误阻止了事件处理
2. 检查 `.mp-item` 元素是否有 `pointer-events: none` 样式
3. 检查事件监听器是否正确绑定

### 7. 快速修复尝试

如果上述调试都没有发现问题，尝试：

1. **清除浏览器缓存**，硬刷新页面 (Cmd+Shift+R)
2. **重启 pi-bridge**：
```bash
pkill -f pi-bridge.ts
cd ~/ai-home/piweb-bridge
./start.sh
```
3. **检查 OpenResty 配置**：
```bash
cd ~/openresty
./nginx/sbin/nginx -t
./nginx/sbin/nginx -s reload
```

---

## 预期的正确行为

1. ✅ API `/providers` 返回 `my-provider` 和 3 个模型
2. ✅ 前端 `loadProviders()` 正确加载并显示这 3 个模型
3. ✅ 点击模型可以切换，UI 更新显示新的模型名
4. ✅ 新建会话使用切换后的模型（通过 `defaultModel` 变量）

如果任何一个步骤不符合预期，说明对应环节有问题。
