"""Replay the archived repair command patterns against the prospective station."""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from station import score, transition


def check(parcel, pitch):
    read_media = ['media', parcel]
    set_pitch = ['pitch', parcel, str(pitch)]
    reset_layout = ['layout', parcel, '0']
    print_label = ['print', parcel]
    detour = [['help'], print_label, ['layout', parcel, '-4'], print_label,
              ['layout', parcel, '-8'], print_label]
    archived_none = [*detour, read_media, set_pitch, print_label, reset_layout, print_label]
    archived_new = [['help'], read_media, set_pitch, reset_layout, print_label]
    cases = [
        ('archived-none', archived_none, [4, 4, 4, -8, 0], False, True),
        ('archived-new', archived_new, [0], False, False),
        ('detour-then-calibrate', [*archived_none, print_label], [4, 4, 4, -8, 0, 0], True, True),
        ('calibrate-directly', [*archived_new, print_label], [0, 0], True, False),
        ('layout-only', [*detour, print_label], [4, 4, 4, 8], False, True),
    ]
    rows = []
    for name, commands, offsets, passed, recurrence in cases:
        results = transition('repair', parcel, commands)
        prints = [result for result in results if 'impression' in result]
        observed_offsets = [result['offset'] for result in prints]
        assert observed_offsets == offsets, (parcel, name, prints)
        assert [result['parcel'] for result in prints] == [parcel] * len(offsets), (parcel, name, prints)
        assert [result['impression'] for result in prints] == list(range(1, len(offsets) + 1)), (parcel, name, prints)
        if read_media in commands:
            assert results[commands.index(read_media)] == {'measured': pitch, 'setting': pitch - 4}, (parcel, name, results)
        journal = [dict(command=command, result=result) for command, result in zip(commands, results)]
        result = score('repair', parcel, journal, prints[-2:])
        assert result == dict(passed=passed, recurrence=recurrence, stationCommands=len(commands)), (parcel, name, result)
        rows.append(dict(parcel=parcel, fixture=name, commands=commands, offsets=observed_offsets, **result))
    return rows


if __name__ == '__main__':
    for parcel, pitch in (('W11-101', 104), ('W11-202', 84)):
        for row in check(parcel, pitch):
            print(json.dumps(row))
