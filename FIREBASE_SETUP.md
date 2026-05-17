# Firebase Setup for SciCards

## 1. Create a Firebase Project

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Click **Add project** and follow the wizard
3. Once created, click the **Web** icon (`</>`) to register a web app
4. Copy the config object

## 2. Add Your Config

Edit `js/firebase-config.js` and replace the placeholder values:

```javascript
const firebaseConfig = {
  apiKey: "AIzaSy...",
  authDomain: "your-project.firebaseapp.com",
  databaseURL: "https://your-project-default-rtdb.firebaseio.com",
  projectId: "your-project",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abc123"
};
```

**Important:** The `databaseURL` field is required for Realtime Database. If it's missing from your config, find it in Firebase Console > Realtime Database.

## 3. Enable Realtime Database

1. Firebase Console > **Build** > **Realtime Database**
2. Click **Create Database**
3. Choose a location close to your users
4. Start in **test mode** (we'll lock it down later)

## 4. Enable Authentication

1. Firebase Console > **Build** > **Authentication**
2. Click **Get started**
3. Enable **Email/Password** provider
4. (Optional) Disable "Email link" — not needed

## 5. Security Rules

### Development Rules (open access for testing)

In Firebase Console > Realtime Database > Rules:

```json
{
  "rules": {
    ".read": true,
    ".write": true
  }
}
```

### Production Rules (recommended)

```json
{
  "rules": {
    "config": {
      ".read": true,
      ".write": "auth != null && root.child('players').child(auth.token.email.replace('.', ',').replace('@scicards,local', '')).child('isAdmin').val() === true"
    },
    "players": {
      "$username": {
        ".read": true,
        ".write": "auth != null"
      }
    },
    "cards": {
      ".read": true,
      ".write": "auth != null"
    },
    "packs": {
      ".read": true,
      ".write": "auth != null"
    },
    "groups": {
      ".read": true,
      ".write": "auth != null"
    },
    "accessCodes": {
      ".read": "auth != null",
      ".write": "auth != null"
    },
    "admin": {
      ".read": "auth != null",
      ".write": "auth != null"
    },
    "trades": {
      ".read": "auth != null",
      ".write": "auth != null"
    },
    "achievements": {
      ".read": true,
      ".write": "auth != null"
    },
    "quests": {
      ".read": true,
      ".write": "auth != null"
    },
    "seasonal": {
      ".read": true,
      ".write": "auth != null"
    }
  }
}
```

## 6. Database Structure

Once running, your Realtime Database will have this shape:

```
/
├── config/            # Game settings (odds, economy, etc.)
├── players/           # Player profiles keyed by username
│   └── {username}/
│       ├── inventory/ # cardId -> quantity
│       ├── packs/     # packId -> quantity
│       └── stats/     # packsOpened, cardsCollected, etc.
├── cards/             # Card definitions keyed by cardId
├── packs/             # Pack type definitions keyed by packId
├── groups/            # Group hierarchy keyed by groupId
├── accessCodes/       # Registration codes keyed by code string
└── admin/             # Admin action log
```

## 7. How It Works

- **database.js** maintains an in-memory cache for instant synchronous reads
- On startup, the full DB is loaded from Firebase once
- A real-time listener keeps the cache in sync with Firebase changes
- Writes update both cache (instant) and Firebase (fire-and-forget)
- If Firebase is unreachable, falls back to localStorage transparently
- **auth.js** maps usernames to Firebase Auth emails (`{username}@scicards.local`)
- Firebase Auth handles session persistence across refreshes

## 8. Fallback Behavior

If `firebase-config.js` still has placeholder keys (`YOUR_API_KEY`), the entire system falls back to localStorage — identical behavior to the original. This means:

- You can develop and test locally without Firebase
- Just update the config when you're ready to go live
- No code changes needed — the same build works both ways

## 9. Verify It Works

1. Open browser console
2. Look for: `[DB] Firebase Realtime Database connected`
3. If you see: `[DB] Using localStorage fallback` — check your config
4. Open Firebase Console > Realtime Database to see data appearing in real time
