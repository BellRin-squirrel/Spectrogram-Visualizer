// モーダルダイアログ制御モジュール

// フィルター管理モーダル
const filterModal = document.getElementById("filterModal");
const filterTableBody = document.getElementById("filterTableBody");
const closeFilterModalBtn = document.getElementById("closeFilterModalBtn");
const finishFilterModalBtn = document.getElementById("finishFilterModalBtn");
const addNewFilterRowBtn = document.getElementById("addNewFilterRowBtn");

// 保存時フィルター選択ダイアログ
const saveConfirmModal = document.getElementById("saveConfirmModal");
const closeSaveModalBtn = document.getElementById("closeSaveModalBtn");
const btnCancelSave = document.getElementById("btnCancelSave");
const btnSaveWithoutFilter = document.getElementById("btnSaveWithoutFilter");
const btnSaveWithFilter = document.getElementById("btnSaveWithFilter");

// エディタ終了確認モーダル
const closeConfirmModal = document.getElementById("closeConfirmModal");
const closeConfirmText = document.getElementById("closeConfirmText");
const closeCancelXBtn = document.getElementById("closeCancelXBtn");
const btnCancelClose = document.getElementById("btnCancelClose");
const btnConfirmClose = document.getElementById("btnConfirmClose");

let saveCallbacks = null;
let closeCallback = null;

export function initModals() {
  btnCancelSave.addEventListener("click", () => {
    saveConfirmModal.style.display = "none";
    if (saveCallbacks?.onCancel) saveCallbacks.onCancel();
    saveCallbacks = null;
  });
  closeSaveModalBtn.addEventListener("click", () => {
    saveConfirmModal.style.display = "none";
    if (saveCallbacks?.onCancel) saveCallbacks.onCancel();
    saveCallbacks = null;
  });
  btnSaveWithoutFilter.addEventListener("click", () => {
    saveConfirmModal.style.display = "none";
    if (saveCallbacks?.onSaveWithoutFilter) saveCallbacks.onSaveWithoutFilter();
    saveCallbacks = null;
  });
  btnSaveWithFilter.addEventListener("click", () => {
    saveConfirmModal.style.display = "none";
    if (saveCallbacks?.onSaveWithFilter) saveCallbacks.onSaveWithFilter();
    saveCallbacks = null;
  });

  btnCancelClose.addEventListener("click", () => { closeConfirmModal.style.display = "none"; });
  closeCancelXBtn.addEventListener("click", () => { closeConfirmModal.style.display = "none"; });
  btnConfirmClose.addEventListener("click", () => {
    closeConfirmModal.style.display = "none";
    if (closeCallback) closeCallback();
    closeCallback = null;
  });

  closeFilterModalBtn.addEventListener("click", () => { filterModal.style.display = "none"; });
  finishFilterModalBtn.addEventListener("click", () => { filterModal.style.display = "none"; });
}

export function openFilterModal(filterManager, onRenderNeeded) {
  filterTableBody.innerHTML = "";
  filterManager.filters.forEach((f) => {
    const tr = document.createElement("tr");
    const currentGain = f.gain !== undefined ? f.gain : 100;
    const sliderInitialVal = Math.min(200, currentGain);

    tr.innerHTML = `
      <td><input type="number" class="filter-input-num min-input" value="${Math.round(f.minFreq)}" min="20" max="80000" /></td>
      <td><input type="number" class="filter-input-num max-input" value="${Math.round(f.maxFreq)}" min="20" max="80000" /></td>
      <td>
        <div class="volume-control-cell">
          <input type="range" class="volume-slider gain-slider" min="0" max="200" step="1" value="${sliderInitialVal}" />
          <div class="volume-input-wrapper">
            <input type="number" class="volume-input-num gain-num" min="0" max="10000" step="1" value="${currentGain}" />
            <span class="volume-unit">%</span>
          </div>
        </div>
      </td>
      <td><input type="color" class="filter-color-picker color-input" value="${f.color}" /></td>
      <td><button class="filter-delete-btn del-btn">削除</button></td>
    `;

    const minInput = tr.querySelector(".min-input");
    const maxInput = tr.querySelector(".max-input");
    const gainSlider = tr.querySelector(".gain-slider");
    const gainNum = tr.querySelector(".gain-num");
    const colorInput = tr.querySelector(".color-input");
    const delBtn = tr.querySelector(".del-btn");

    gainSlider.addEventListener("input", () => {
      const val = parseInt(gainSlider.value, 10);
      gainNum.value = val;
      filterManager.updateFilter(f.id, { gain: val });
      onRenderNeeded();
    });

    gainNum.addEventListener("change", () => {
      let val = parseInt(gainNum.value, 10);
      if (isNaN(val)) val = 100;
      val = Math.max(0, Math.min(10000, val));
      gainNum.value = val;
      gainSlider.value = Math.min(200, val);
      filterManager.updateFilter(f.id, { gain: val });
      onRenderNeeded();
    });

    minInput.addEventListener("change", () => {
      filterManager.updateFilter(f.id, { minFreq: parseFloat(minInput.value) || 20 });
      onRenderNeeded();
    });
    maxInput.addEventListener("change", () => {
      filterManager.updateFilter(f.id, { maxFreq: parseFloat(maxInput.value) || 80000 });
      onRenderNeeded();
    });
    colorInput.addEventListener("input", () => {
      filterManager.updateFilter(f.id, { color: colorInput.value });
      onRenderNeeded();
    });
    delBtn.addEventListener("click", () => {
      filterManager.removeFilter(f.id);
      openFilterModal(filterManager, onRenderNeeded);
      onRenderNeeded();
    });

    filterTableBody.appendChild(tr);
  });

  addNewFilterRowBtn.onclick = () => {
    filterManager.addDefaultFilter();
    openFilterModal(filterManager, onRenderNeeded);
    onRenderNeeded();
  };

  filterModal.style.display = "flex";
}

export function openSaveConfirmModal(callbacks) {
  saveCallbacks = callbacks;
  saveConfirmModal.style.display = "flex";
}

export function openCloseConfirmModal(editorName, onConfirm) {
  closeCallback = onConfirm;
  closeConfirmText.innerHTML = `「${editorName}」を閉じますか？<br />保存されていない編集データは破棄されます。`;
  closeConfirmModal.style.display = "flex";
}