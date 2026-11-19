# W11 prospective admission, 2026-11-20 Shanghai

The local survey found 38 candidate ledgers and 16 distinct committed publications with recovery plans. Fourteen targeted `wiki:return-handoff`, one targeted `wiki:label-offset` and one targeted `wiki:seal-cutoff`. Zero pairs satisfied the predecessor check. The survey covers the synthetic archives listed in `survey.json`.

Installed AFK 0.2.158 queried both dedicated producer profiles for `github:w11/parcel` with the same staging, parcel 2.0, non-pickup process query. Both gathers exited 0 and returned `[]`. For work item #812 the old candidate `eb732b11accc2799c93eae8a11c5067b0090db5c1f392fd43f1d3830b17c0256` failed three independent assertions. Its correction job `78359cf43748cac661ce92e47580ee7208a6acb039738528f325f59de80c2060` had zero attempts. At the time of the audit the single 2026-11-19 UTC distillation reservation was spent. The producer's next eligible time is 2026-11-20 00:00 UTC.

The v2 freeze pins the scenario prompts, station, scoring and arm schedule from `6ed3e4e4b8ae59f24d24796c09b7f453925d6b27`. Both parameters remain scheduled for each of environment, repair and process. All three groups lack a release binding. Offline replay reported 18 `missing-publications` seats and six unmatched groups. The frozen formal envelope was 0 cents with a 75-cent seat ceiling. One matched sample needs 225 cents of reservations. This check used zero paid calls and reserved zero cents. All 48 historical release manifest entries passed checksum verification. Historical coverage is 12/18.

## Offline replay

Pass the private evidence directory as `study`. These checks work on a relocated copy with Python 3 and `shasum`. The scoring black-box log is a separate synthetic regression.

```sh
cd "$study" || exit 1
shasum -a 256 -c <<'SUMS' || exit 1
f079993eafd27375b6ab70deceefe76cc4ea406675f34873fd02316043761ce9  queue-v2/lock.json
73ec00df75d5618edd19796c5d1f9a88bc64f488af7b49f0389011fc24b3fd6b  queue-v2/frozen/protocol.py
4134cfdef7976667204fc8d0e2f982abb32f79746ddbfcbd7d6389a099dd23dc  queue-v2/frozen/station.py
baf72d8fab43c727aafdb832ff7fa9f6def19ff48d9ca5985739e2eae4c419f6  report.json
db12afa0b01b4fcbeb7d3dcd49653eb3f838ee9947ab8fc0544661d7c22dd046  budget.json
a10fa62b4f02c2568f0e295c1aa1295819b120f6a619ef8d56e6c286f45d19b4  survey.json
02a90926b3db237cc73db06469387bf879d7fbb93c30f15e7a2bedfc38322716  gather/query.json
37517e5f3dc66819f61f5a7bb8ace1921282415f10551d2defa5c3eb0985b570  gather/old-gather.stdout
37517e5f3dc66819f61f5a7bb8ace1921282415f10551d2defa5c3eb0985b570  gather/new-gather.stdout
05bdbb91ba3ce764158c3ed88d624b72aeb57399012a489851325a4caa49abae  historical-check.log
3bf574c28fa22380a25ef1956576e69424546d54e18d03c1487bb3a0f802e195  scoring-regression.log
SUMS
python3 -B queue-v2/frozen/protocol.py replay "$PWD/queue-v2" | cmp - report.json
```
