/**
 * 只读参考示例（骨架包）：中性数据模块模式。
 * 展示「内联数据 + 增删改查纯函数 + 渲染分离」的组织方式——
 * 仅参考结构与模式，不要照抄业务内容；本文件只读，写入会被拒绝。
 * 沙箱口径：数据内联/localStorage，不发起网络请求，无 import/ESM。
 */
function createDataModule(config) {
  'use strict';

  config = config || {};
  var storageKey = config.storageKey || null; // 传 key 则持久化到 localStorage，否则纯内存

  var state = {
    seq: 1,          // 内部自增编号（新增项 id 由模块分配，不依赖外部传 id）
    items: [],       // 业务条目：{ id, title, note, updatedAt }
  };

  /** 内联初始数据：贴合产品语义的示例条目（真实项目替换为业务数据）。 */
  function seed(entries) {
    (entries || []).forEach(function (entry) {
      add(entry);
    });
  }

  function persist() {
    if (!storageKey) return;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify({ seq: state.seq, items: state.items }));
    } catch (err) {
      /* 存储不可用（隐私模式/容量满）时降级为内存态，不阻断交互 */
    }
  }

  function restore() {
    if (!storageKey) return;
    try {
      var raw = window.localStorage.getItem(storageKey);
      if (!raw) return;
      var saved = JSON.parse(raw);
      if (saved && Array.isArray(saved.items)) {
        state.items = saved.items;
        state.seq = saved.seq || state.items.length + 1;
      }
    } catch (err) {
      /* 数据损坏时忽略，回到内存态 */
    }
  }

  /** 查询：全部条目（返回副本，防止外部直接改内部状态）。 */
  function list() {
    return state.items.slice();
  }

  /** 查询：按断言函数过滤。 */
  function find(predicate) {
    return state.items.filter(predicate);
  }

  /** 新增：校验失败返回 null（调用方负责提示，不在此处弹窗）。 */
  function add(entry) {
    if (!entry || typeof entry.title !== 'string' || !entry.title.trim()) return null;
    var item = {
      id: state.seq++,
      title: entry.title.trim(),
      note: entry.note || '',
      updatedAt: Date.now(),
    };
    state.items.push(item);
    persist();
    return item;
  }

  /** 更新：id 不存在返回 null。 */
  function update(id, patch) {
    var item = null;
    for (var i = 0; i < state.items.length; i++) {
      if (state.items[i].id === id) { item = state.items[i]; break; }
    }
    if (!item) return null;
    if (patch && typeof patch.title === 'string') item.title = patch.title.trim();
    if (patch && typeof patch.note === 'string') item.note = patch.note;
    item.updatedAt = Date.now();
    persist();
    return item;
  }

  /** 删除：返回是否真的删除了。 */
  function remove(id) {
    var before = state.items.length;
    state.items = state.items.filter(function (item) { return item.id !== id; });
    var removed = state.items.length < before;
    if (removed) persist();
    return removed;
  }

  restore();

  return { seed: seed, list: list, find: find, add: add, update: update, remove: remove };
}

/* 使用形态（示例，勿在此处直接执行）：
 *   var records = createDataModule({ storageKey: 'app-records' });
 *   records.seed([{ title: '示例条目' }]);
 *   var created = records.add({ title: '新条目', note: '说明' });
 *   renderList(records.list()); // 渲染函数在业务代码中实现
 */
