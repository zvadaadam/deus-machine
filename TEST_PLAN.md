# 🧪 Element Selector Testing Plan

## Status: Ready to Test

---

## Test Environment Setup

1. **Start the application**
   ```bash
   cd /Users/zvada/Documents/BOX/box-ide/.conductor/kiev
   npm run tauri:dev
   ```

2. **Ensure dev-browser is running**
   - Should auto-start when BrowserPanel mounts
   - Check console for "MCP server running on port XXXX"

3. **Create a workspace** (if needed)
   - Select a repository
   - Create new workspace

---

## Test Scenarios

### ✅ Test 1: Load Test Page
**Goal:** Verify test HTML page loads and automation injects

**Steps:**
1. Navigate to Browser tab in right panel
2. Enter URL: `file:///Users/zvada/Documents/BOX/box-ide/.conductor/kiev/test-element-selector.html`
3. Click "Go"
4. Wait for page to load
5. Check console panel for injection logs

**Expected Results:**
- ✅ Page loads successfully
- ✅ Green ⚡ "AI-ready" status appears
- ✅ Console shows: "✓ Automation script injected successfully"
- ✅ Console shows: "✓ Browser automation registered and ready"

---

### ✅ Test 2: Activate Element Selector
**Goal:** Verify visual effects activate correctly

**Steps:**
1. With test page loaded
2. Click the 🎯 Target button in browser toolbar
3. Observe visual changes

**Expected Results:**
- ✅ Target button shows pulsing animation (text-primary animate-pulse)
- ✅ Console shows: "🎯 Activating element selector - Click any element to inspect"
- ✅ Native cursor disappears
- ✅ Custom SVG crosshair cursor appears and follows mouse
- ✅ Moving mouse shows no lag

---

### ✅ Test 3: Hover Visual Feedback
**Goal:** Verify overlay and label work correctly

**Steps:**
1. With selector active
2. Hover over different elements:
   - h1#main-title
   - button#btn-submit.primary
   - div.card#card-1
   - input#username

**Expected Results:**
- ✅ Blue overlay (rgba(58,150,221,0.3)) appears over hovered element
- ✅ Overlay matches element bounds exactly
- ✅ Element info label appears above element (or inside if no room)
- ✅ Label shows correct format: "tag#id.class WxH"
  - Example: "button#btn-submit.primary 120×40"
- ✅ Overlay transitions smoothly (0.1s ease)
- ✅ Label updates in real-time as you move between elements

---

### ✅ Test 4: Element Selection & Data Capture
**Goal:** Verify element data is captured and sent to chat

**Steps:**
1. With selector active
2. Click on button#btn-submit (the blue "Submit Form" button)
3. Watch console and chat

**Expected Results:**
- ✅ Console shows: "✓ Element selected: button#btn-submit"
- ✅ Console shows: "[Dashboard] 🎯 Inserting element data to chat"
- ✅ Console shows: "[WorkspaceDetail] Inserting text to message input"
- ✅ Selector mode deactivates (cursor returns to normal)
- ✅ Target button stops pulsing
- ✅ Chat message input contains formatted element data

---

### ✅ Test 5: Verify Element Data Format
**Goal:** Verify markdown formatting is correct

**Expected format in chat:**
```markdown
## 🎯 Selected Element

**Element:** `button#btn-submit.primary`
**Path:** body > div.container > div.button-group > button#btn-submit
**Position:** (XXX, YYY)
**Size:** 120×40
**Text:** "Submit Form"

### Attributes
- **id**: `"btn-submit"`
- **class**: `"primary"`
- **type**: `"button"`

### Computed Styles
- **color**: rgb(255, 255, 255)
- **backgroundColor**: rgb(0, 102, 204)
- **fontSize**: 14px
- **fontWeight**: 400
- **display**: inline-block
- **position**: static

---
_You can ask me to modify this element, debug it, or help with related styling._
```

**Verify:**
- ✅ All sections present
- ✅ Element selector matches (button#btn-submit.primary)
- ✅ CSS path is complete and accurate
- ✅ Position and size are reasonable numbers
- ✅ Attributes are listed correctly
- ✅ Computed styles show actual values (not defaults)
- ✅ Text content is captured

---

### ✅ Test 6: Multiple Element Selections
**Goal:** Verify multiple selections work independently

**Steps:**
1. Click Target button to activate
2. Select button#btn-submit
3. Verify data appears in chat
4. Click Target button again
5. Select div.card#card-1
6. Verify new data appends to chat (with double newline separator)

**Expected Results:**
- ✅ Each selection creates separate markdown block
- ✅ Blocks are separated by double newline
- ✅ No overlap or corruption of data
- ✅ All element data is accurate for each selection

---

### ✅ Test 7: Escape Key Deactivation
**Goal:** Verify Escape key cancels selection mode

**Steps:**
1. Click Target button to activate
2. Move mouse around (see overlay)
3. Press Escape key

**Expected Results:**
- ✅ Selector mode deactivates
- ✅ Custom cursor disappears
- ✅ Native cursor returns
- ✅ Overlay and label disappear
- ✅ Target button stops pulsing
- ✅ Console shows: "Element selector deactivated (Escape pressed)"

---

### ✅ Test 8: Different Element Types
**Goal:** Verify selector works with various HTML elements

**Test these elements:**
- Input field (input#username)
- Select dropdown (select#role)
- Textarea (textarea#bio)
- Div with classes (div.card.alert-info)
- List items (li elements)
- Elements without IDs

**Verify for each:**
- ✅ Overlay appears correctly
- ✅ Label shows correct tag#id.class format
- ✅ Click captures all data
- ✅ Attributes are correct
- ✅ Computed styles are accurate

---

### ✅ Test 9: Cross-Origin Handling
**Goal:** Verify graceful degradation for external websites

**Steps:**
1. Navigate to `https://example.com`
2. Check Target button state

**Expected Results:**
- ✅ Target button is disabled (grayed out)
- ✅ Tooltip shows it's disabled
- ✅ Cross-origin banner appears with info message
- ✅ No errors in console

---

### ✅ Test 10: End-to-End with AI
**Goal:** Verify AI can understand the element data

**Steps:**
1. Select button#btn-submit
2. Add message: "Why is this button blue?"
3. Send to AI

**Expected Results:**
- ✅ AI receives full element context
- ✅ AI can reference specific styles (backgroundColor: rgb(0, 102, 204))
- ✅ AI provides relevant answer about the styling

---

## 🐛 Known Issues to Watch For

1. **postMessage timing**: If selection happens before iframe fully loads
2. **CSS path accuracy**: Ensure path is complete (body > ... > element)
3. **Overlay positioning**: Should match element bounds exactly
4. **Text truncation**: innerText/innerHTML should truncate at 200 chars
5. **Memory leaks**: Visual elements should clean up on deactivate

---

## 📋 Checklist Summary

- [ ] Test 1: Load test page ✅
- [ ] Test 2: Activate selector ✅
- [ ] Test 3: Hover feedback ✅
- [ ] Test 4: Element capture ✅
- [ ] Test 5: Data format ✅
- [ ] Test 6: Multiple selections ✅
- [ ] Test 7: Escape key ✅
- [ ] Test 8: Different elements ✅
- [ ] Test 9: Cross-origin ✅
- [ ] Test 10: AI integration ✅

---

## 📝 Test Results

_To be filled in after testing..._

### Bugs Found
1. ...

### Performance Notes
1. ...

### Visual Issues
1. ...

### Success Rate
- [ ] 100% - All tests passed
- [ ] 90%+ - Minor issues
- [ ] <90% - Significant issues

---

**Tester:** AI Agent
**Date:** 2025-10-18
**Build:** Post-implementation
