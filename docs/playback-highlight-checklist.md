# Playback Highlight Verification Checklist

## Core Synchronization
- Start app with fresh session; click play on any track in the list.
- Verify exactly one active row highlight appears and matches the player state.
- Toggle global play/pause repeatedly (slow and fast clicks).
- Confirm tracklist icon state always matches main player icon/state.

## State Transitions
- Validate each transition on the active row:
  - `loading` while command is pending
  - `playing` during playback
  - `paused` when paused
  - `ended` when playback ends without an immediate next track
  - `error` when a playback/auth error occurs
- Confirm stale hold keeps highlight stable during short SDK/API sync gaps.

## Queue/Skip/Shuffle
- Use next/previous controls rapidly and confirm highlight follows current track only.
- Enable shuffle and skip several times; ensure previous row highlight clears.
- Validate highlight after queue jump and after row-based play command.

## Browser Matrix
- iPadOS Safari: first-play user gesture, pause/resume, shuffle, tab switch.
- macOS Safari and Chrome: same scenarios plus resize while playback is active.
- Windows 11 Edge/Chrome/Firefox: same scenarios plus fast repeated commands.

## Multi-Tab
- Open two tabs of the app with same account.
- Trigger playback in one tab and verify the other tab converges to same active row state.
- Ensure no duplicated simultaneous highlights.
