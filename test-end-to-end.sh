#!/bin/bash

echo "🧪 END-TO-END FUNCTIONALITY TEST"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo

# Test 1: Backend Health
echo "1️⃣  Testing Backend Health..."
HEALTH=$(curl -s http://localhost:3333/api/health)
echo "   Response: $HEALTH"

if echo "$HEALTH" | grep -q '"status":"ok"'; then
    echo "   ✅ Backend is healthy"
else
    echo "   ❌ Backend health check failed"
    exit 1
fi
echo

# Test 2: Database Stats
echo "2️⃣  Testing Database Stats..."
STATS=$(curl -s http://localhost:3333/api/stats)
echo "   Response: $STATS"

if echo "$STATS" | grep -q '"workspaces"'; then
    WORKSPACE_COUNT=$(echo "$STATS" | grep -o '"workspaces":[0-9]*' | cut -d: -f2)
    MESSAGE_COUNT=$(echo "$STATS" | grep -o '"messages":[0-9]*' | cut -d: -f2)
    echo "   ✅ Found $WORKSPACE_COUNT workspaces and $MESSAGE_COUNT messages"
else
    echo "   ❌ Stats query failed"
    exit 1
fi
echo

# Test 3: Workspaces API
echo "3️⃣  Testing Workspaces API..."
WORKSPACES=$(curl -s http://localhost:3333/api/workspaces)

if echo "$WORKSPACES" | grep -q 'directory_name'; then
    FIRST_WORKSPACE=$(echo "$WORKSPACES" | grep -o '"directory_name":"[^"]*"' | head -1 | cut -d: -f2 | tr -d '"')
    echo "   ✅ Workspaces API working (first: $FIRST_WORKSPACE)"
else
    echo "   ❌ Workspaces API failed"
    exit 1
fi
echo

# Test 4: Sessions API
echo "4️⃣  Testing Sessions API..."
SESSIONS=$(curl -s http://localhost:3333/api/sessions)

if echo "$SESSIONS" | grep -q 'session_id\|workspace_id\|id'; then
    SESSION_COUNT=$(echo "$SESSIONS" | grep -o '"id"' | wc -l | tr -d ' ')
    echo "   ✅ Sessions API working ($SESSION_COUNT sessions)"
else
    echo "   ❌ Sessions API failed"
    exit 1
fi
echo

# Test 5: Frontend Accessibility
echo "5️⃣  Testing Frontend Server..."
FRONTEND=$(curl -s http://localhost:1420)

if echo "$FRONTEND" | grep -q 'vite'; then
    echo "   ✅ Frontend is accessible"
else
    echo "   ❌ Frontend not accessible"
    exit 1
fi
echo

# Test 6: Sidecar Status
echo "6️⃣  Testing Sidecar Status..."
SIDECAR=$(curl -s http://localhost:3333/api/sidecar/status)
echo "   Response: $SIDECAR"

if echo "$SIDECAR" | grep -q '"running":true'; then
    SOCKET=$(echo "$SIDECAR" | grep -o '"socketPath":"[^"]*"' | cut -d: -f2- | tr -d '"')
    echo "   ✅ Sidecar is running (socket: $SOCKET)"
else
    echo "   ❌ Sidecar not running"
    exit 1
fi
echo

# Test 7: Socket File Exists
echo "7️⃣  Testing Socket File..."
if [ -S "$SOCKET" ]; then
    echo "   ✅ Socket file exists: $SOCKET"
else
    echo "   ❌ Socket file not found"
    exit 1
fi
echo

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🎉 ALL TESTS PASSED!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo
echo "✅ Backend API: http://localhost:3333"
echo "✅ Frontend UI: http://localhost:1420"
echo "✅ Database: Connected ($WORKSPACE_COUNT workspaces, $MESSAGE_COUNT messages)"
echo "✅ Sidecar: Running with socket IPC"
echo
echo "🚀 Your reverse-engineered Conductor is fully functional!"
