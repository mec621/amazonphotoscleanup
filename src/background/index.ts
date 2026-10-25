// The toolbar icon opens the side panel. All real work happens in extension pages.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
