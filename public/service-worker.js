// Every tab gets a side panel of its own: a click on the extension icon opens sidepanel.html?tab=<id> for that tab.
// Other tabs show no panel, and switching back to the tab shows its panel again. There is no window-wide panel.
const PANEL = 'sidepanel.html';

async function setUp() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }); // the click goes to onClicked below
    await chrome.sidePanel.setOptions({ path: PANEL, enabled: false });          // no panel on tabs that did not ask for one
  } catch (e) {
    console.error('Could not set up the side panel', e);
  }
}
setUp();
chrome.storage.local.remove('panelPerTab').catch(() => {}); // a setting of 0.3 test builds

chrome.action.onClicked.addListener((tab) => {
  if (tab.id == null || tab.id < 0) return;
  // Not awaited: open() must be called while the click still counts as a user gesture.
  chrome.sidePanel.setOptions({ tabId: tab.id, path: `${PANEL}?tab=${tab.id}`, enabled: true })
    .catch((e) => console.error('Could not set the tab panel', e));
  chrome.sidePanel.open({ tabId: tab.id }).catch((e) => console.error('Could not open the panel', e));
});
