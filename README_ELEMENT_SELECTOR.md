# 🎯 Element Selector - Quick Start Guide

## What is This?

A **Cursor-style element selector** that lets you visually select elements in the browser and automatically insert their details into your AI chat. Perfect for debugging, styling, and understanding your UI!

---

## 🚀 How to Use

### 1. Start the App
```bash
npm run tauri:dev
```

### 2. Open a Workspace
- Click "+ Create Workspace" in the sidebar
- Or select an existing workspace

### 3. Open the Browser Tab
- Look for the **Browser** tab in the right panel (🌐 icon)
- The browser panel will appear

### 4. Load a Page
You can load:
- **Local file:** `file:///path/to/file.html`
- **Test page:** `file:///Users/zvada/Documents/BOX/box-ide/.conductor/kiev/test-element-selector.html`
- **Localhost:** `http://localhost:3000` (if you have a dev server running)

**Note:** External websites (https://...) are usually blocked by CORS for security.

### 5. Inject Automation
- Click the **⚡ Zap button** in the browser toolbar
- Wait for the green checkmark: "✅ AI-ready"
- You should see "Automation script injected" in the console

### 6. Activate Element Selector
- Click the **🎯 Target button** (next to the Zap button)
- The button will start **pulsing**
- Your cursor will change to a **custom crosshair**

### 7. Select an Element
- **Hover** over any element to see:
  - Blue overlay highlighting the element
  - Info label showing: `tag#id.class width×height`
- **Click** the element to capture its data
- The selector will automatically deactivate
- The element data will appear in your **chat input** (center panel)

### 8. Chat About the Element!
The chat now contains full details:
- Element type, ID, and classes
- CSS path (for debugging)
- Position and size
- All HTML attributes
- Computed styles (colors, fonts, etc.)

Ask the AI things like:
- "Why isn't this button working?"
- "Make this button green"
- "Center this element"
- "Fix the padding on this card"

---

## 📋 What Data Gets Captured?

When you click an element, you get:

```markdown
## 🎯 Selected Element

**Element:** `button#submit.btn-primary`
**Path:** body > div.container > form > button#submit
**Position:** (450, 300)
**Size:** 120×40
**Text:** "Submit Form"

### Attributes
- **id**: `"submit"`
- **class**: `"btn-primary"`
- **type**: `"submit"`
- **disabled**: `"false"`

### Computed Styles
- **color**: rgb(255, 255, 255)
- **backgroundColor**: rgb(0, 123, 255)
- **fontSize**: 16px
- **fontWeight**: 700
- **display**: inline-block
- **position**: relative
```

---

## ⌨️ Keyboard Shortcuts

- **Escape**: Exit element selector mode (returns to normal cursor)
- **Cmd/Ctrl + Enter** (in chat): Send message to AI

---

## 🎨 Visual Feedback

### When Active:
- 🎯 **Target button pulses** (blue animation)
- ✨ **Custom crosshair cursor** follows your mouse
- 🔵 **Blue overlay** appears on hover (smooth transitions)
- 🏷️ **Element label** shows element info

### When Inactive:
- 🎯 Target button is normal (gray)
- 👆 Regular cursor
- No overlays

---

## 🧪 Test Page

We've created a test page with various elements to practice:

**Location:** `test-element-selector.html` in this directory

**Contains:**
- Buttons (with IDs, classes, disabled states)
- Form inputs (text, email, select, textarea)
- Cards with nested elements
- Lists and alerts
- Various styling states

**To use:**
1. Copy the full path: `/Users/zvada/Documents/BOX/box-ide/.conductor/kiev/test-element-selector.html`
2. Paste into browser URL bar
3. Click "Go"
4. Click ⚡ to inject automation
5. Click 🎯 to activate selector
6. Start clicking elements!

---

## ❓ Troubleshooting

### "Target button is disabled"
- ✅ Make sure a page is loaded
- ✅ Make sure automation is injected (⚡ button clicked)
- ✅ Check if the page is cross-origin (external websites won't work)

### "Nothing happens when I click Target"
- ✅ Check the console tab for error messages
- ✅ Make sure the page finished loading
- ✅ Try clicking ⚡ Zap again to re-inject automation

### "Cursor doesn't change"
- ✅ The custom cursor only appears when hovering over the iframe
- ✅ Make sure you clicked the Target button (it should pulse)
- ✅ Try pressing Escape and reactivating

### "Element data doesn't appear in chat"
- ✅ Make sure a workspace is selected (left sidebar)
- ✅ Check the console for "🎯 Inserting element data" message
- ✅ Scroll down in the chat textarea (it might be below existing content)

### "Cross-origin blocked" error
- ⚠️ This is expected for external websites (https://example.com)
- ✅ Use local files (file://...) or localhost (http://localhost:...)
- ℹ️ Cross-origin pages are blocked by browser security (CORS)

---

## 💡 Use Cases

### 1. **Debugging CSS Issues**
Select an element to see its:
- Computed styles (actual rendered values)
- Position and size
- Display and position properties

### 2. **Understanding UI Structure**
The CSS path shows you exactly where an element lives in the DOM:
```
body > div#app > main.container > section.hero > button.cta
```

### 3. **Creating Tests**
Use the CSS selector to create Playwright/Cypress tests:
```typescript
await page.click('button#submit.btn-primary');
```

### 4. **AI-Assisted Styling**
Select an element and ask:
- "Make this button bigger"
- "Change the font to match the heading"
- "Add a hover effect"

### 5. **Quick Element Inspection**
Instead of opening DevTools, just click and see:
- All attributes
- All computed styles
- Exact dimensions

---

## 📚 Related Documentation

- **Full Implementation Details:** `IMPLEMENTATION_COMPLETE.md`
- **Test Plan:** `TEST_PLAN.md`
- **Implementation Tracker:** `ELEMENT_SELECTOR_IMPLEMENTATION.md`

---

## 🎉 That's It!

You now have a powerful visual element selector integrated into your AI coding assistant. Happy debugging! 🚀

**Questions?** Check the documentation files or ask in the chat!
