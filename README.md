# YouTube cdn : фикс зависаний, возможно костыль, но мне помогло

Если видео замирает, а остальной YouTube работает — дело не в браузере. Провайдер рвёт соединения к серверам Google, и часть видео уходит на локальный кэш-узел, который отдаёт только уже закэшированное.

Здесь две части. Можно взять любую, но вместе работают заметно лучше.

---

## Часть 1. Стратегия для zapret

`general (ALT14).bat` — это копия `general (ALT11).bat` из **zapret-discord-youtube 1.10.4**, в которой изменён только блок YouTube/Google: вместо `fake,multisplit` + `fooling=ts` используется `fake,fakedsplit` + `badseq`. Discord и остальные правила не тронуты.

**Установка:**

1. Нужна сборка [zapret-discord-youtube](https://github.com/Flowseal/zapret-discord-youtube/releases) версии **1.10.4**.
2. Скопируй `general (ALT14).bat` в папку zapret — туда же, где лежат `general (ALT11).bat` и `service.bat`.
3. Запусти `service.bat` → пункт `1` (Install Service) → выбери `general (ALT14).bat`.
4. Вверху меню появится `Strategy: general (ALT14)`. Служба перезапустится сама.

> Файл рассчитан на версию 1.10.4. На другой сборке может не запуститься — сначала обнови zapret.

---

## Часть 2. Расширение для Chrome

Блокирует тот самый узел `googlevideo.com`, который завис, чтобы плеер переключился на рабочий.

1. Распакуй папку `yt-cdn-fix` в постоянное место, например `C:\yt-cdn-fix`. После установки папку не перемещать.
2. Открой `chrome://extensions`.
3. Включи «Режим разработчика» (Developer mode).
4. Нажми «Загрузить распакованное расширение» и выбери папку `yt-cdn-fix`


`general (ALT14).bat` — модификация стратегии `general (ALT11).bat` из [zapret-discord-youtube](https://github.com/Flowseal/zapret-discord-youtube).
