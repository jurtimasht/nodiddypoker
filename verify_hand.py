"""Check a hand yourself:  python verify_hand.py proof.json

The file comes from the site: History -> a hand -> Fair shuffle -> Download proof.
Written separately from the site's own code (fair.py, static/fair.js) on purpose and needs nothing but Python.
The protocol is described in README.md, "Provably fair shuffle"."""
import hashlib
import hmac
import json
import sys

ALL_CARDS = sorted(rank + suit for rank in "23456789TJQKA" for suit in "shdc")


def digest(*parts):
    blob = b""
    for part in parts:
        raw = part if isinstance(part, bytes) else str(part).encode("utf-8")
        blob += len(raw).to_bytes(4, "big") + raw
    return hashlib.sha256(blob).digest()


def shuffle_from(combined):
    """The combined seed -> (which deck is played, deal order)."""
    buffer, counter = [], 0

    def pick(n):
        nonlocal buffer, counter
        while True:
            if not buffer:
                block = digest("ndp/stream", combined, counter.to_bytes(4, "big"))
                counter += 1
                buffer = [int.from_bytes(block[i:i + 4], "big") for i in range(0, 32, 4)]
            x = buffer.pop(0)
            if x < (1 << 32) // n * n:
                return x % n
    deck, order = pick(4), list(range(52))
    for i in range(51, 0, -1):
        j = pick(i + 1)
        order[i], order[j] = order[j], order[i]
    return deck, order


def expected_positions(seen):
    """Deck position -> the card the player saw there. Positions follow from the rules, not from the server's word."""
    n, hole, out = seen["seats"], seen["hole_count"], {}
    for seat, cards in seen["hole"].items():
        for k, card in enumerate(cards):
            if card != "back":
                out[int(seat) * hole + k] = card
    pos = n * hole
    boards = [seen["board"]] + ([seen["board2"]] if seen["double_board"] else [])
    for start, count in ((0, 3), (3, 1), (4, 1)):
        pos += 1                                    # burn card
        for board in boards:
            for k in range(count):
                if start + k < len(board):
                    out[pos + k] = board[start + k]
            pos += count
    return out


def verify(proof):
    """List of (what was checked, True / False / None if it can't be checked, details)."""
    if proof.get("v") != 1:
        return [("format", False, "unknown proof version")]
    sid, root = bytes.fromhex(proof["id"]), bytes.fromhex(proof["root"])
    results = []

    witness = proof.get("witness")
    if witness:
        same = witness["root"] == proof["root"]
        listed = {str(s["seat"]): s["hash"] for s in proof["seeds"]}
        if witness.get("hashes"):
            same = same and witness["hashes"] == listed
        results.append(("locked before the deal", same, "the browser saw this deck lock before any seed was revealed"))
    else:
        results.append(("locked before the deal", None, "this browser was not at the table when the shuffle started"))

    seats = [s["seat"] for s in proof["seeds"]]
    ok = seats == sorted(set(seats)) and all(
        digest("ndp/seed", sid, root, s["seat"], bytes.fromhex(s["seed"])).hex() == s["hash"] for s in proof["seeds"])
    people = sum(s["by"] == "player" for s in proof["seeds"])
    results.append(("seeds match their hashes", ok, f"{people} from players, {len(seats) - people} from the server"))
    results.append(("somebody else's seed is in", True if people else None,
                    "" if people else "every seed was made by the server: this hand proves nothing"))

    parts = []
    for s in proof["seeds"]:
        parts += [s["seat"], bytes.fromhex(s["seed"])]
    combined = digest("ndp/combine", sid, proof["table"], proof["hand"], root, *parts)
    played, order = shuffle_from(combined)
    results.append(("the seeds pick the deck", played == proof["deck"] and combined.hex()[:8] == proof["fp"],
                    f"deck {played + 1} of 4"))

    genuine, deck_hashes = len(proof["decks"]) == 4, []
    for i, deck in enumerate(proof["decks"]):
        if i == played:
            commits = [bytes.fromhex(c) for c in deck.get("commits", [])]
            genuine = genuine and len(commits) == 52 and "key" not in deck
        else:
            key, cards = bytes.fromhex(deck.get("key", "")), deck.get("cards", [])
            genuine = genuine and sorted(cards) == ALL_CARDS
            commits = [digest("ndp/card", hmac.new(key, k.to_bytes(4, "big"), "sha256").digest(), c)
                       for k, c in enumerate(cards)]
        deck_hashes.append(digest("ndp/deck", b"".join(commits)))
    genuine = genuine and digest("ndp/root", sid, *deck_hashes) == root
    results.append(("unused decks are genuine", genuine, "3 sealed decks opened: 52 different cards in each"))

    want = expected_positions(proof["seen"])
    commits = proof["decks"][played].get("commits", []) if played < len(proof["decks"]) else []
    opened = {o["pos"]: o for o in proof["open"]}
    ok = set(opened) == set(want) and len(opened) == len(proof["open"]) and len(commits) == 52
    for pos, card in want.items():
        o = opened.get(pos)
        ok = bool(ok and o and o["card"] == card
                  and digest("ndp/card", bytes.fromhex(o["salt"]), card).hex() == commits[order[pos]])
    ok = ok and len(set(want.values())) == len(want)
    results.append(("every card you saw matches", ok, f"{len(want)} cards"))
    retries = proof.get("aborted", [])
    results.append(("no reshuffles", True if not retries else None, "; ".join(a["reason"] for a in retries)))
    return results


def main():
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    with open(sys.argv[1], encoding="utf-8") as f:
        proof = json.load(f)
    try:
        results = verify(proof)
    except (KeyError, TypeError, ValueError, IndexError, AttributeError) as exc:
        print(f"[FAIL] the proof is damaged ({exc!r})")
        return 1
    for name, ok, info in results:
        print(f"[{'FAIL' if ok is False else ' -- ' if ok is None else ' OK '}] {name}" + (f": {info}" if info else ""))
    bad = any(ok is False for _, ok, _ in results)
    print("NOT FAIR: something does not match." if bad else "Everything that can be checked matches.")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
