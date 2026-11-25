// NoDiddyPoker — язык сайта: English (основной) или русский.
// Как работает: страницы пишут тексты по-английски (и сервер тоже), а этот файл в режиме RU
// сам заменяет на экране всё, что знает: по словарю (точная фраза) и по шаблонам (фраза с ником или суммой).
// Переключение без перезагрузки: у каждого текста запоминаем английский оригинал и можем вернуть его.
// Не переводим то, что пишут люди: всё внутри элементов с атрибутом data-notr (чат, новости владельца, ники).
// Выбор хранится в этом браузере (localStorage "poker-lang") — общий для лобби и стола.
(() => {
  const KEY = "poker-lang";
  let lang = "en";
  try { lang = localStorage.getItem(KEY) === "ru" ? "ru" : "en"; } catch (e) {}

  // ---------- словарь: английская фраза → русская ----------
  // Покерные слова, к которым все привыкли, оставлены английскими: Fold, Check, Call, Raise, Bet, All-in,
  // Blind, Hold'em, Omaha, Bomb Pot, Heads-up, MTT, Quick seat, BB.
  const RU = {
    // шапка, вкладки, меню
    "Home": "Главная", "Cash": "Кэш", "Lobby": "Лобби", "← Lobby": "← Лобби",
    "Sections": "Разделы", "players at tables": "игроков за столами",
    "📷 Change photo": "📷 Сменить фото", "🗑 Remove photo": "🗑 Убрать фото",
    "✎ Change nickname": "✎ Сменить ник", "🔑 Change password": "🔑 Сменить пароль",
    "🛠 Owner tools": "🛠 Для владельца", "Log out": "Выйти", "Language": "Язык",
    // вход
    "Log in": "Войти", "Create account": "Создать аккаунт", "Nickname": "Ник", "Password": "Пароль",
    "Invite code": "Код приглашения", "Ask the owner for it": "Спроси у владельца",
    "Pick a nickname (others see it at the table) and a password (6+ characters). Then you can log in from any device.":
      "Придумай ник (его видят за столом) и пароль (от 6 символов). Потом можно входить с любого устройства.",
    "Log in with your nickname and password — from any device.": "Входи по нику и паролю — с любого устройства.",
    "NoDiddyPoker": "NoDiddyPoker",
    // полоса «сижу за столом»
    "You are seated at": "Ты сидишь за столом",
    "— hands keep going. Come back before your turn or you start sitting out.":
      "— раздачи идут. Вернись до своего хода, иначе начнёшь пропускать раздачи.",
    "Back to table": "Вернуться за стол",
    // Home
    "You": "Ты", "Edit profile": "Профиль", "leaderboard": "в рейтинге", "hands": "раздач",
    "in the lobby": "в лобби", "Lobby chat": "Чат лобби", "everyone sees it": "видят все",
    "Message to everyone in the lobby": "Сообщение всем в лобби", "Message everyone…": "Написать всем…", "Send": "Отправить",
    "No messages yet. Say hi — everyone in the lobby sees it.": "Пока пусто. Напиши привет — увидят все в лобби.",
    "Say hi to everyone": "Скажи всем привет", "Today": "Сегодня", "Yesterday": "Вчера",
    "Delete this message": "Удалить сообщение", "No connection — trying again…": "Нет связи — пробую снова…",
    "News": "Новости", "No news yet.": "Новостей пока нет.", "No news yet": "Новостей пока нет",
    "From the owner": "От владельца", "📌 From the owner": "📌 От владельца", "Leaderboard": "Рейтинг",
    // админка
    "🛠 Admin": "🛠 Админка", "Admin": "Админка", "› 🛠 Admin": "› 🛠 Админка", "· only you see this page": "· эту страницу видишь только ты",
    "Admin sections": "Разделы админки", "🏆 Tournaments": "🏆 Турниры", "👥 Players": "👥 Игроки", "📰 News": "📰 Новости",
    "🔑 Invite code": "🔑 Код приглашения", "⚙️ Site": "⚙️ Сайт", "No tournaments yet.": "Турниров пока нет.",
    "Now": "Сейчас", "Coming up": "Скоро", "Drafts": "Черновики", "Finished": "Закончены",
    "Draft": "Черновик", "Registration": "Регистрация", "Running": "Идёт", "Paused": "Пауза", "Cancelled": "Отменён",
    "⚠ Updates are paused — see Admin › Site": "⚠ Обновления на паузе — см. Админка › Сайт",
    "⏳ The site will update when the tables are empty": "⏳ Сайт обновится, когда столы опустеют",
    "⚙ Installing the new version…": "⚙ Ставлю новую версию…",
    "⬆ A new version is ready — open Admin › Site to install it": "⬆ Готова новая версия — поставить: Админка › Сайт",
    // админка: турниры
    "＋ New tournament": "＋ Новый турнир", "players don't see these": "игроки их не видят", "not published": "не опубликован",
    "Open console": "Открыть пульт", "Publish": "Опубликовать", "Edit": "Изменить", "Copy": "Копия", "Results": "Итоги",
    "Hide results": "Скрыть итоги", "Delete this draft?": "Удалить этот черновик?", "Draft deleted.": "Черновик удалён.",
    "No tournaments yet — create one.": "Турниров пока нет — создай первый.",
    "Finished and cancelled tournaments can't be deleted — results stay in the history.": "Законченные и отменённые турниры не удаляются — итоги остаются в истории.",
    "Published — registration is open.": "Опубликовано — регистрация открыта.", "Saved as a draft.": "Сохранено как черновик.",
    "Another tournament is already open — finish or cancel it first.": "Уже открыт другой турнир — сначала закончи или отмени его.",
    "When I press Start": "Когда нажму Start", "At a set time": "В назначенное время", "Start from a template": "Начать с шаблона",
    "A template fills in everything below. You can change any field after.": "Шаблон заполнит всё ниже. Любое поле потом можно поменять.",
    "Basics": "Основное", "Name": "Название", "Game": "Игра", "Start": "Старт", "Date and time": "Дата и время",
    "Registration opens as soon as you publish.": "Регистрация откроется сразу после публикации.", "Max players": "Максимум игроков",
    "Stack and blinds": "Стек и блайнды", "Starting stack": "Стартовый стек", "Level length": "Длина уровня",
    "Same for every level": "Одна для всех уровней", "Blind structure": "Структура блайндов", "Lvl": "Ур.", "Starts": "Начало",
    "+ Level": "+ Уровень", "Reset to template": "Как в шаблоне", "Ante — every player pays it each hand.": "Анте платит каждый игрок в каждой раздаче.",
    "▲ Late registration and rebuys end here": "▲ Здесь заканчиваются поздняя регистрация и ребаи",
    "▲ Late registration ends here": "▲ Здесь заканчивается поздняя регистрация", "▲ Rebuys end here": "▲ Здесь заканчиваются ребаи",
    "Tables and entries": "Столы и вход", "Seats per table": "Мест за столом", "Late registration": "Late registration",
    "Rebuys": "Rebuys", "until the end of level": "до конца уровня",
    "Only when you have 0 chips. You get the starting stack again.": "Только когда фишек 0. Даётся стартовый стек заново.",
    "Rewards": "Награды", "Points for places (MTT leaderboard)": "Очки за места (рейтинг MTT)",
    "🏆 The winner gets a trophy next to the nickname, and the win is posted to News.": "🏆 Победитель получает кубок у ника, а победа появляется в новостях.",
    "Test run": "Пробный запуск", "Add bots — to try the tournament alone or with 1–2 friends": "Добавить ботов — попробовать турнир одному или с 1–2 друзьями",
    "Bots:": "Ботов:", "A tournament with bots gives no points and no trophy.": "Турнир с ботами не даёт очков и кубка.",
    "Edit tournament": "Изменить турнир", "New tournament": "Новый турнир", "Draft — not saved yet": "Черновик — ещё не сохранён",
    "Expected length": "Ожидаемая длина", "Levels": "Уровни", "Stack": "Стек", "Ante from": "Анте с", "no ante": "без анте",
    "Late reg · rebuys": "Late reg · rebuys", "Winner gets": "Победителю", "test — no points": "пробный — без очков",
    "Publish — open registration": "Опубликовать — открыть регистрацию", "Save as draft": "Сохранить черновик", "Save draft": "Сохранить черновик",
    "Players will see it on the MTT tab right after you publish.": "Игроки увидят его на вкладке MTT сразу после публикации.",
    "Give the tournament a name.": "Дай турниру название.", "Pick the date and time.": "Выбери дату и время.",
    "No tournament is open.": "Открытого турнира нет.", "← Tournaments": "← Турниры", "Tournaments": "Турниры",
    "level length": "длина уровня", "paused": "пауза", "to next level": "до следующего уровня", "This is the last level": "Это последний уровень",
    "▶ Start now": "▶ Старт сейчас", "Start the tournament now?": "Начать турнир сейчас?", "Started.": "Турнир начался.",
    "⏸ Pause": "⏸ Пауза", "Paused.": "На паузе.", "▶ Resume": "▶ Продолжить", "Resumed.": "Продолжаем.", "⏭ Next level now": "⏭ Следующий уровень",
    "starting stack": "стартовый стек", "players left": "игроков осталось", "tables": "столов", "rebuys": "ребаев",
    "🕑 Registration is open.": "🕑 Регистрация открыта.", "🕑 No late registration.": "🕑 Поздней регистрации нет.",
    "Late registration extended.": "Поздняя регистрация продлена.", "🤖 Test tournament: bots play, no points.": "🤖 Пробный турнир: играют боты, без очков.",
    "+ 3 bots": "+ 3 бота", "Remove bots": "Убрать ботов", "registered": "записан", "Nobody has registered yet.": "Пока никто не записался.",
    "👁 opens that player's table. ✕ removes a player (asks first): their chips leave the game, place = next out.":
      "👁 открывает стол игрока. ✕ убирает игрока (сначала спросит): его фишки уходят из игры, место — как у следующего вылетевшего.",
    "Log": "Журнал", "Nothing yet.": "Пока пусто.", "Stop the tournament": "Остановить турнир",
    "Hands stop, nobody gets points. Can't be undone.": "Раздачи остановятся, очков никто не получит. Отменить нельзя.",
    "Hands stop, nobody gets prizes. Can't be undone.": "Раздачи остановятся, призов никто не получит. Отменить нельзя.",
    "Cancel tournament…": "Отменить турнир…", "Cancel tournament": "Отменить турнир", "Cancel the tournament?": "Отменить турнир?",
    "Keep playing": "Играть дальше", "Tournament cancelled.": "Турнир отменён.", "← All tournaments": "← Все турниры",
    "you": "ты", "· sitting out": "· отошёл", "soon": "скоро", "Tournament paused": "Турнир на паузе", "Tournament resumed": "Турнир продолжается",
    "Tournament cancelled": "Турнир отменён", "Tournament restored after a restart — the unfinished hand was cancelled": "Турнир восстановлен после перезапуска — незаконченная раздача отменена", "Bots are only allowed in test tournaments.": "Боты — только в пробных турнирах.",
    "At least 2 players are needed.": "Нужно хотя бы 2 игрока.", "This is already the last level.": "Это уже последний уровень.",
    "The tournament is not running.": "Турнир сейчас не идёт.", "The tournament is not paused.": "Турнир не на паузе.",
    "Only a draft can be changed.": "Менять можно только черновик.", "Only a draft can be deleted.": "Удалить можно только черновик.",
    "Only a draft can be opened.": "Открыть можно только черновик.", "No such tournament.": "Такого турнира нет.",
    "From 1 to 20 bots.": "От 1 до 20 ботов.", "Pick a level from the current one to the last.": "Выбери уровень от текущего до последнего.",
    "This player is not in the game.": "Этого игрока уже нет в игре.", "Bad start time.": "Неверное время старта.",
    // вкладка MTT и стол турнира
    "all times are your local time": "время — по твоим часам", "MTT points": "Очки MTT", "How it works": "Как это устроено",
    "Everyone starts with the": "Все начинают с", "same stack": "одинаковым стеком", ". Play chips only.": ". Фишки игровые, не деньги.",
    "Blinds and ante go up": "Блайнды и анте растут", "every level.": "с каждым уровнем.",
    "Lose all chips — you're out (or": "Проиграл все фишки — ты вылетел (или", "rebuy": "rebuy", "early on, if allowed).": "в начале, если разрешён).",
    "Last one standing wins the 🏆. Places give points.": "Последний оставшийся забирает 🏆. За места дают очки.",
    "Back to my table": "Вернуться за мой стол", "hands keep going without you": "раздачи идут и без тебя", "you're out": "ты вылетел",
    "you get the starting stack again": "получишь стартовый стек заново", "today": "сегодня", "tomorrow": "завтра",
    "starts when the owner presses Start": "начнётся, когда владелец нажмёт Start", "no late reg": "без поздней регистрации",
    "no rebuys": "без ребаев", "✓ You're in": "✓ Ты записан", "Register": "Записаться", "Late register": "Записаться поздно",
    "Registration is closed": "Регистрация закрыта", "Unregister": "Отписаться", "by the owner": "по кнопке",
    "No tournaments planned. Ask Sanya to set one up!": "Турниров пока нет. Попроси Сашу устроить!", "All places": "Все места",
    "No tournaments played yet.": "Турниров ещё не было.", "last level": "последний уровень",
    "🏆 Tournament over": "🏆 Турнир окончен", "wins!": "побеждает!", "Thanks for playing! You can watch the rest.": "Спасибо за игру! Можно досмотреть.",
    "Rebuys are still open — you get the starting stack again.": "Ребаи ещё открыты — получишь стартовый стек заново.",
    "Your cards are folded for you until you come back": "Пока не вернёшься, твои карты сбрасываются сами",
    "Rebuy done — you're back in.": "Rebuy сделан — ты снова в игре.", "Thanks for playing!": "Спасибо за игру!", "You": "Ты",
    // деньги в турнирах
    "ante from the start": "анте с первого уровня", "the start": "первого уровня",
    "Next Prize": "Следующий приз", "Avg. Stack": "Средний стек", "Players Left": "Осталось", "MTT money": "Деньги MTT",
    "Won": "Выиграно", "Buy-in and prizes": "Бай-ин и призы", "Buy-in, $": "Бай-ин, $", "free": "бесплатно", "Prize pool": "Призовой фонд",
    "Every entry and every rebuy costs this. The prize pool is all of it together.": "Столько стоит каждый вход и каждый ребай. Призовой фонд — всё это вместе.",
    "Paid places depend on how many enter: up to 3 — winner takes all, 4–6 — two places, 7–10 — three (50/30/20%), more — up to 9 places.":
      "Сколько мест получают призы, зависит от числа входов: до 3 — всё победителю, 4–6 — два места, 7–10 — три (50/30/20%), больше — до 9 мест.",
    "🏆 The winner gets a trophy next to the nickname, and the win is posted to News. The site only counts the money — friends settle up themselves.":
      "🏆 Победитель получает кубок у ника, а победа появляется в новостях. Сайт только считает деньги — рассчитываетесь вы сами.",
    "Prizes:": "Призы:", "you · no prize": "ты · без приза",
    "Last one standing wins the 🏆. The top places share the": "Последний оставшийся забирает 🏆. Верхние места делят", "prize pool": "призовой фонд",
    "(all the buy-ins).": "(все бай-ины).",
    "📌 Leaderboard": "📌 Рейтинг", "Players": "Игроки", "📌 Players": "📌 Игроки", "📌 Tournaments": "📌 Турниры",
    "This is a tournament table — register in the lobby (MTT tab).": "Это стол турнира — запишись в лобби (вкладка MTT).",
    "In a tournament you can't leave the table or rebuy here — use Sit out.": "В турнире нельзя встать или докупиться за столом — можно только отойти.",
    "Registration is closed.": "Регистрация закрыта.", "You are already registered.": "Ты уже записан.",
    "The tournament is full.": "Мест в турнире больше нет.", "You are not registered.": "Ты не записан.",
    "The tournament has started — you can't unregister now.": "Турнир уже начался — отписаться нельзя.",
    "Only players who are out can rebuy.": "Rebuy — только для вылетевших.", "Rebuys are closed.": "Rebuy уже закрыт.",
    "This tournament is not open.": "Этот турнир не открыт.", "Leave your cash table first.": "Сначала выйди из-за кэш-стола.",
    "Player": "Игрок", "Hands": "Раздачи", "Diddy leaderboard": "Рейтинг Дидди",
    "Bad beats": "Бэдбиты", "Sickest": "Рекорд", "Factor": "Фактор", "Diddy factor": "Дидди", "No bad beats yet": "Бэдбитов пока нет",
    "Pots won": "Выиграно банков", "Biggest pot": "Самый большой банк", "Profit": "Итог", "profit": "итог",
    "Crack a 69%+ favourite in an all-in. The bigger the favourite, the more points.":
      "Переедь в олл-ине фаворита с 69%+. Чем больше фаворит, тем больше очков.",
    "No hands played yet.": "Ещё не сыграно ни одной раздачи.", "No hands played yet": "Ещё ни одной раздачи",
    "Show less": "Свернуть", "Online": "Онлайн", "At tables": "За столами", "In the lobby": "В лобби",
    "Nobody is online right now.": "Сейчас никого нет на сайте.",
    "Join": "Сесть", "Back": "Вернуться", "Full": "Мест нет", "Sit first": "Сесть",
    // Cash
    "No-limit, 2 cards. The classic.": "Без лимита, 2 карты. Классика.",
    "Pot-limit, 4 cards, use exactly 2.": "Пот-лимит, 4 карты, в комбинации ровно 2 свои.",
    "Everyone puts 5 BB, straight to the flop, two boards.": "Все ставят по 5 BB, сразу флоп, две доски.",
    "Game": "Игра", "nobody yet": "пока никого", "you pick the buy-in when you sit": "бай-ин выбираешь, когда садишься",
    "Tables": "Столы", "One table at a time.": "Только за одним столом.",
    "Tables with players are always on top.": "Столы с игроками всегда сверху.",
    "Who's where": "Кто где", "All tables are full.": "Все столы заняты.", "Show": "Показать",
    "Playing now": "Идёт игра", "Full · playing": "Мест нет · идёт игра",
    "Empty — needs 2 players to start": "Пусто — нужно 2 игрока", "Empty — 1 vs 1": "Пусто — 1 на 1",
    "1 vs 1": "1 на 1", "You are seated at another table — leave it first.": "Ты сидишь за другим столом — сначала выйди из-за него.",
    "This table is full.": "За этим столом нет мест.",
    // MTT
    "Tournaments": "Турниры", "We're working on it": "Скоро будет", "Play cash game meanwhile": "А пока — кэш",
    // профиль
    "Your profile": "Твой профиль", "Close": "Закрыть", "Change photo": "Сменить фото", "📷 photo": "📷 фото",
    "OK": "OK", "Cancel": "Отмена", "New nickname": "Новый ник", "Current password": "Текущий пароль",
    "New password": "Новый пароль", "New password (6+ characters)": "Новый пароль (от 6 символов)", "Save password": "Сохранить пароль",
    "The photo must be under 4 MB.": "Фото должно быть меньше 4 МБ.", "Uploading photo…": "Загружаю фото…",
    "Photo updated — it shows at the table and on the leaderboard.": "Фото обновлено — его видно за столом и в рейтинге.",
    "Remove your profile photo?": "Убрать фото профиля?",
    "Password changed. Other devices need to log in again.": "Пароль изменён. На других устройствах нужно войти заново.",
    "Account created! Add a photo in the menu under your name.": "Аккаунт создан! Фото можно добавить в меню под твоим ником.",
    "Log out on this device?": "Выйти на этом устройстве?",
    // владелец
    "🛠 Owner tools": "🛠 Для владельца", "Only you see this": "Это видишь только ты",
    "— give it to friends so they can create an account": "— дай его друзьям, чтобы они создали аккаунт",
    "Save": "Сохранить", "Statistics": "Статистика",
    "Clears the all-time leaderboard for everyone. Accounts and photos stay.": "Обнуляет рейтинг у всех. Аккаунты и фото остаются.",
    "Reset statistics": "Обнулить статистику", "← Back to the lobby": "← Назад в лобби",
    "News text": "Текст новости", "For example: Friday 21:00 — Bomb Pot night, buy-in 20k": "Например: пятница 21:00 — вечер Bomb Pot, бай-ин 20k",
    "Pin to the top": "Закрепить сверху", "Post": "Опубликовать", "Pin": "Закрепить", "Unpin": "Открепить", "Delete": "Удалить",
    "Delete this news item?": "Удалить эту новость?", "Posted — everyone sees it on Home.": "Опубликовано — все видят на главной.",
    "Delete this message for everyone?": "Удалить это сообщение у всех?",
    "Reset password": "Сбросить пароль", "No accounts yet.": "Аккаунтов пока нет.", "Invite code saved.": "Код приглашения сохранён.",
    "Reset all-time statistics for EVERY player? Profiles and photos stay.": "Обнулить статистику ВСЕХ игроков? Профили и фото останутся.",
    "Statistics reset.": "Статистика обнулена.",
    // обновление сайта
    "⏳ Waiting for the first check of GitHub…": "⏳ Жду первую проверку GitHub…",
    "⚠ The server has changes that are not on GitHub — automatic updates are paused. Ask Claude to sort it out.":
      "⚠ На сервере есть изменения, которых нет на GitHub — обновления на паузе. Попроси Claude разобраться.",
    "🧪 New version on GitHub — running the tests…": "🧪 Новая версия на GitHub — идут тесты…",
    "✖ New version on GitHub failed the tests — it can't be installed": "✖ Новая версия на GitHub не прошла тесты — ставить нельзя",
    "Update site": "Обновить сайт", "Starting…": "Запускаю…", "Update started.": "Обновление запущено.",
    "Install the new version? The site restarts when nobody is sitting at a table (tables are cleared).":
      "Поставить новую версию? Сайт перезапустится, когда за столами никого не будет (столы очистятся).",
    // стол: шапка и кнопки
    "Chat": "Чат", "Results": "Итоги", "History": "История", "Invite": "Позвать",
    "Lobby: profile, photo, leaderboard": "Лобби: профиль, фото, рейтинг", "Who is up and who is down": "Кто в плюсе, кто в минусе",
    "Hand history: pick any hand and replay it": "История раздач: выбери любую и посмотри повтор", "Copy the link": "Скопировать ссылку",
    "Check / Fold": "Check / Fold", "Call any": "Call any",
    "Bet amount": "Сумма ставки", "Max": "Макс", "Pot": "Банк", "All": "Всё",
    "Waiting for players…": "Ждём игроков…", "Hand history": "История раздач", "Chat message": "Сообщение в чат",
    "Tonight's results": "Итоги вечера",
    "Bought in — buy-in plus all rebuys. Now — chips at the table (or what they left with).":
      "Вложено — бай-ин плюс все докупки. Сейчас — фишки на столе (или с чем ушёл).",
    "Bought in": "Вложено", "Now": "Сейчас", "Result": "Итог", "Who pays whom": "Кто кому платит",
    "Start a new count": "Начать подсчёт заново", "Nobody has sat down yet.": "Пока никто не садился.",
    "Everyone is even — nobody owes anything.": "Все при своих — никто никому не должен.",
    "Start a new count? Everyone's current chips become their buy-in, and players who left disappear from the list.":
      "Начать подсчёт заново? Текущие фишки у всех станут бай-ином, а ушедшие пропадут из списка.",
    "Take a seat": "Сесть за стол", "Buy-in": "Бай-ин", "Sit down": "Сесть", "Just watch": "Просто смотреть",
    "You are out of chips": "Фишки закончились",
    "Rebuy to keep playing. Or close this and watch — you can rebuy any time with the button at the bottom left.":
      "Докупись, чтобы играть дальше. Или закрой и смотри — докупиться можно в любой момент кнопкой внизу слева.",
    "Rebuy amount": "Сумма докупки", "💰 Rebuy": "💰 Докупиться", "Watch": "Смотреть", "Close and watch": "Закрыть и смотреть",
    "Connection lost. Reconnecting…": "Связь пропала. Подключаюсь…",
    "Turn your phone": "Поверни телефон",
    "The table is made for landscape. The game keeps going — your seat and your timer too.":
      "Стол сделан для горизонтального экрана. Игра идёт дальше — и твоё место, и таймер.",
    "To start": "В начало", "Step back": "Шаг назад", "Step forward": "Шаг вперёд", "To end": "В конец",
    "▶ Play": "▶ Смотреть", "⏸ Pause": "⏸ Пауза", "Bad beat": "Bad beat",
    "☕ Sit out": "☕ Отойти", "Get dealt in again": "Снова получать карты", "Skip hands without leaving the table": "Пропускать раздачи, не вставая из-за стола",
    "🚪 Leave table": "🚪 Выйти из-за стола", "Leave the table? Your chips will be cashed out to the results.":
      "Выйти из-за стола? Твои фишки уйдут в итоги вечера.",
    "You can check for free. Fold anyway?": "Можно бесплатно сделать Check. Всё равно Fold?",
    "Link copied. Send your friends the poker login and password separately.": "Ссылка скопирована. Логин и пароль отправь друзьям отдельно.",
    "Copy the link and send it to your friends:": "Скопируй ссылку и отправь друзьям:",
    "Amounts in big blinds (BB)": "Суммы в больших блайндах (BB)", "Amounts in chips": "Суммы в фишках",
    "Right-click: show amounts in chips or BB": "Правый клик: суммы в фишках или в BB",
    "Everyone sees this card": "Эту карту видят все", "Click to show this card to everyone": "Нажми, чтобы показать карту всем",
    "Click to show this card when the hand ends": "Нажми, чтобы показать карту после раздачи",
    "Will be shown when the hand ends — click to cancel": "Покажется после раздачи — нажми, чтобы отменить",
    "Time bank used up": "Запас времени закончился", "Can no longer win": "Уже не может выиграть",
    "dealing without you…": "раздают без тебя…", "seconds to rebuy — the next hand waits for you": "секунд на докупку — следующая раздача ждёт тебя",
    "rebuying…": "докупается…", "equity": "шанс", "dead": "всё",
    "· blinds": "· блайнды", "· buy-in": "· бай-ин", "sitting out": "отошёл", "empty": "пусто", "Table": "Стол",
    "Preflop": "Префлоп", "Flop": "Флоп", "Turn": "Тёрн", "River": "Ривер",
    "🔔 Your turn — NoDiddyPoker": "🔔 Твой ход — NoDiddyPoker",
    "Everyone is all-in — cards up.": "Все в олл-ине — карты открыты.", "All-in — cards revealed": "Олл-ин — карты открыты",
    "Fold (left)": "Fold (ушёл)",
    "Click to throw something": "Нажми, чтобы кинуть", "Throw something": "Кинуть в игрока", "Nice hand": "Красиво!", "Nice hand!": "Красиво!", "Shit": "Говно",
    // честная перемешка
    "Fair": "Честность", "Fair shuffle": "Честная перемешка", "Fair shuffle: your phrase and the proof": "Честная перемешка: твоя фраза и проверка",
    "Before every hand the server locks the decks, then every player at the table adds a secret seed. The seeds together decide the shuffle, so nobody can steer it, not even the server. After the hand you can check it.":
      "Перед каждой раздачей сервер запечатывает колоды, потом каждый игрок за столом добавляет свой секрет. Порядок карт выходит из всех секретов вместе, поэтому подстроить его не может никто, даже сервер. После раздачи это можно проверить.",
    "Your phrase": "Твоя фраза", "Anything you like": "Что угодно",
    "It never leaves this browser. Random bytes are added every hand, so you can keep the same phrase or leave it empty.":
      "Она не уходит из этого браузера. К ней каждую раздачу добавляются случайные байты, так что фразу можно не менять или оставить пустой.",
    "This browser can't make a seed here (it needs https), so the server makes one for you.":
      "Здесь этот браузер не может сделать секрет (нужен https), поэтому его делает за тебя сервер.",
    "Last hand": "Последняя раздача", "Fingerprint": "Отпечаток", "own seed": "свой секрет", "seed from the server": "секрет от сервера",
    "Good to know: the proof shows the shuffle was not steered. The server still deals the cards, so it does know them. A hand where every seed came from the server proves nothing.":
      "Важно: проверка показывает, что перемешку не подстроили. Карты всё равно раздаёт сервер, и он их знает. Раздача, где все секреты от сервера, ничего не доказывает.",
    "Verify the last hand": "Проверить последнюю раздачу", "🎲 Verify the shuffle": "🎲 Проверить перемешку", "⬇ Download proof": "⬇ Скачать доказательство",
    "Checking…": "Проверяю…", "Something does not match!": "Что-то не сходится!", "Everything that can be checked matches": "Всё, что можно проверить, сходится",
    "The math matches, but no player added a seed": "Расчёт сходится, но своего секрета не добавил никто",
    "This browser can't check here (it needs https). Download the proof instead.": "Здесь этот браузер не может проверить (нужен https). Скачай доказательство.",
    "The proof is damaged": "Доказательство повреждено",
    "The decks were locked before anyone's seed was known": "Колоды запечатали до того, как стал известен хоть один секрет",
    "The decks were changed after they were locked": "Колоды поменяли после того, как запечатали",
    "This browser did not see the decks being locked": "Этот браузер не видел, как запечатали колоды",
    "Your seed is in the shuffle": "Твой секрет участвует в перемешке", "Your seed is missing or was changed": "Твоего секрета нет или его подменили",
    "You had no seed in this hand": "Твоего секрета в этой раздаче не было",
    "All seeds match the hashes promised before": "Все секреты подходят к обещанным отпечаткам",
    "A seed does not match its promised hash": "Какой-то секрет не подходит к своему отпечатку",
    "Seeds from players": "Секретов от игроков:", "Every seed came from the server: this hand proves nothing": "Все секреты от сервера: эта раздача ничего не доказывает",
    "The seeds give exactly this shuffle": "Из секретов выходит именно эта перемешка", "The seeds give a different shuffle": "Из секретов выходит другая перемешка",
    "The 3 unused decks are real: 52 different cards": "3 лишние колоды настоящие: по 52 разные карты", "An unused deck is not a real deck": "Одна из лишних колод ненастоящая",
    "Every card you saw was in its place": "Каждая карта, которую ты видел, была на своём месте", "A card you saw was not in its place": "Какая-то карта, которую ты видел, была не на своём месте",
    "No reshuffles before this hand": "Перед раздачей не перемешивали заново", "Reshuffles before this hand": "Перемешиваний заново перед раздачей:",
    "Shuffle dropped: not enough players.": "Перемешка отменена: не хватает игроков.",
    "The server says your seed did not arrive, but this browser sent it.": "Сервер говорит, что твой секрет не дошёл, но этот браузер его отправил.",
    "Warning: the locked deck was changed. Your seed was not sent.": "Внимание: запечатанную колоду поменяли. Твой секрет не отправлен.",
    "Warning: the list of seeds was changed. Your seed was not sent.": "Внимание: список секретов поменяли. Твой секрет не отправлен.",
    // комбинации
    "High card": "Старшая карта", "Pair": "Пара", "Two pair": "Две пары", "Three of a kind": "Сет",
    "Straight": "Стрит", "Flush": "Флеш", "Full house": "Фулл-хаус", "Four of a kind": "Каре",
    "Straight flush": "Стрит-флеш", "Royal flush": "Роял-флеш",
    // ошибки с сервера
    "You can't throw that.": "Таким кинуть нельзя.", "There is nobody to throw at.": "Кидать не в кого.",
    "Slow down 🙂": "Помедленнее 🙂", "Too many messages — wait a minute 🙂": "Слишком много сообщений — подожди минутку 🙂",
    "Only the owner can delete messages.": "Удалять сообщения может только владелец.",
    "No such hand.": "Такой раздачи нет.", "That hand is no longer stored.": "Эта раздача уже не хранится.",
    "Only the table owner can reset the results.": "Обнулить итоги может только владелец.",
    "You are already at the table.": "Ты уже за столом.", "Pick a nickname in the lobby first.": "Сначала выбери ник в лобби.",
    "Take a seat first.": "Сначала сядь за стол.", "Unknown command.": "Неизвестная команда.",
    "Log in first.": "Сначала войди.", "You can change your nickname after you leave the table.": "Ник можно сменить, когда выйдешь из-за стола.",
    "Only the owner can do this.": "Это может только владелец.", "Write something first.": "Сначала напиши текст.",
    "No such news.": "Такой новости нет.", "Unknown action.": "Неизвестное действие.", "No such player.": "Такого игрока нет.",
    "This player is seated at a table — wait until they leave.": "Этот игрок сидит за столом — подожди, пока он выйдет.",
    "Only the owner can update the site.": "Обновлять сайт может только владелец.",
    "This version is not tested and ready yet.": "Эта версия ещё не проверена.",
    "That does not look like an image. Use JPG, PNG, WebP or GIF.": "Это не похоже на картинку. Подойдут JPG, PNG, WebP или GIF.",
    "Only the owner can reset the statistics.": "Обнулить статистику может только владелец.",
    "Invite code: 4–40 characters.": "Код приглашения: 4–40 символов.",
    "Wrong invite code. Ask the owner for it.": "Неверный код приглашения. Спроси у владельца.",
    "Nickname: 2–16 characters — letters, digits, space, dot, dash, underscore.":
      "Ник: 2–16 символов — буквы, цифры, пробел, точка, дефис, подчёркивание.",
    "That nickname is taken.": "Этот ник уже занят.", "Wrong nickname or password.": "Неверный ник или пароль.",
    "Your current password is wrong.": "Текущий пароль неверный.", "Password: at least 6 characters.": "Пароль: минимум 6 символов.",
    "Too many attempts. Wait 10 minutes and try again.": "Слишком много попыток. Подожди 10 минут и попробуй снова.",
    "It is not your turn.": "Сейчас не твой ход.", "You cannot check: call the bet or fold.": "Check нельзя: Call или Fold.",
    "Nothing to call — you can check.": "Уравнивать нечего — можно Check.", "Invalid amount.": "Неверная сумма.",
    "A raise must be bigger than the current bet.": "Raise должен быть больше текущей ставки.",
    "You cannot raise now: only call or fold.": "Сейчас Raise нельзя: только Call или Fold.",
    "You do not have that many chips.": "У тебя нет столько фишек.", "Enter the amount as a number.": "Введи сумму числом.",
    "That name is already at the table.": "Игрок с таким ником уже за столом.",
    "You are already at the table (in another tab?).": "Ты уже за столом (в другой вкладке?).",
    "You can only rebuy when you are out of chips.": "Докупиться можно, только когда фишки закончились.",
    "Wait until the hand is over.": "Подожди конца раздачи.", "You have no cards to show.": "Тебе нечего показывать.",
    "Which card?": "Какую карту?", "Something went wrong on the server.": "На сервере что-то пошло не так.",
  };

  // ---------- шаблоны: фразы с ником, суммой, числом ----------
  const A = "([+−-]?\\d[\\d,.]*(?:k)?(?: BB)?)";          // сумма: «1,500», «15 BB», «0.5 BB», «10k»
  const hand = (s) => s.split(" / ").map((x) => RU[x] || x).join(" / ");
  const POT = { "Pot": "Банк", "Main pot": "Основной банк" };
  const potName = (s) => POT[s] || s.replace(/^Side pot (\d+)$/, "Побочный банк $1");
  const MONTHS = { January: "января", February: "февраля", March: "марта", April: "апреля", May: "мая", June: "июня",
    July: "июля", August: "августа", September: "сентября", October: "октября", November: "ноября", December: "декабря" };
  const MON = "(" + Object.keys(MONTHS).join("|") + ")";
  const PATTERNS = [
    // даты: «Today, 13:53», «25 November, 13:53», «25 November 2026», «25 November at 13:54»
    [/^(Today|Yesterday), (\d\d:\d\d)$/, (m) => `${RU[m[1]]}, ${m[2]}`],
    [new RegExp(`^(\\d{1,2}) ${MON}(?: (\\d{4}))?(?:,| at) (\\d\\d:\\d\\d)$`), (m) => `${m[1]} ${MONTHS[m[2]]}${m[3] ? " " + m[3] : ""}, ${m[4]}`],
    [new RegExp(`^(\\d{1,2}) ${MON}(?: (\\d{4}))?$`), (m) => `${m[1]} ${MONTHS[m[2]]}${m[3] ? " " + m[3] : ""}`],
    [/^(.+) \(you\)$/, (m) => `${m[1]} (ты)`],
    [/^(.+) joined NoDiddyPoker$/, (m) => `${m[1]} теперь с нами в NoDiddyPoker`],
    [/^(.+) is the new #1 on the Diddy leaderboard \((.+)\)$/, (m) => `${m[1]} — новый №1 в рейтинге Дидди (${m[2]})`],
    [/^(.+) is the new #1 on the leaderboard \((.+)\)$/, (m) => `${m[1]} — новый №1 в рейтинге (${m[2]})`],
    [/^(\d+) live$/, (m) => `${m[1]} идёт`],
    // короткие даты: «Fri 4 Dec, 21:00» (+ хвост « · 4 per table»)
    [/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(, \d\d:\d\d)?( · .+)?$/, (m) => {
      const wd = { Mon: "пн", Tue: "вт", Wed: "ср", Thu: "чт", Fri: "пт", Sat: "сб", Sun: "вс" }[m[1]];
      const mo = { Jan: "янв", Feb: "фев", Mar: "мар", Apr: "апр", May: "мая", Jun: "июн", Jul: "июл", Aug: "авг", Sep: "сен", Oct: "окт", Nov: "ноя", Dec: "дек" }[m[3]];
      const tail = m[5] ? " · " + m[5].slice(3).split(" · ").map((x) => T(x).replace(/^(\d) per table$/, "$1 за столом").replace(/^test$/, "пробный")).join(" · ") : "";
      return `${wd} ${m[2]} ${mo}${m[4] || ""}${tail}`;
    }],
    // журнал турнира (тексты сервера)
    [/^(.+) started: (\d+) players, (\d+) tables?$/, (m) => `${m[1]}: старт, игроков ${m[2]}, столов ${m[3]}`],
    [/^Level (\d+): blinds (.+?)(, ante (.+))?$/, (m) => `Уровень ${m[1]}: блайнды ${m[2]}${m[3] ? ", анте " + m[4] : ""}`],
    [/^(.+) is out — (\d+)(st|nd|rd|th) place$/, (m) => `${m[1]} вылетел — ${m[2]}-е место`],
    [/^(.+) is out — \? place$/, (m) => `${m[1]} вылетел`],
    [/^(.+) rebuys$/, (m) => `${m[1]} делает rebuy`],
    [/^Table (\d+) closed, players moved$/, (m) => `Стол ${m[1]} закрыт, игроки пересажены`],
    [/^(.+) wins (.+)!$/, (m) => `${m[1]} выигрывает ${m[2]}!`],
    [/^(.+) chips · (\d+)-min levels$/, (m) => `${m[1]} фишек · уровни по ${m[2]} мин`],
    [/^(\$[\d,.]+) buy-in$/, (m) => `бай-ин ${m[1]}`],
    [/^(\$[\d,.]+) buy-in · (.+)$/, (m) => `бай-ин ${m[1]} · ${T(m[2])}`],
    [/^prize pool (\$[\d,.]+)( · next prize (\$[\d,.]+) \((\d+)(st|nd|rd|th)\))?$/, (m) => `призовой фонд ${m[1]}` + (m[2] ? ` · следующий приз ${m[3]} (${m[4]}-е)` : "")],
    [/^prize pool (\$[\d,.]+) · buy-in (\$[\d,.]+)$/, (m) => `призовой фонд · бай-ин ${m[2]}`],
    [/^(\$[\d,.]+) with (\d+) players$/, (m) => `${m[1]} при ${m[2]} игроках`],
    [/^With (\d+) players: prize pool (\$[\d,.]+) →$/, (m) => `При ${m[1]} игроках: фонд ${m[2]} →`],
    [/^(\d+)(st|nd|rd|th) (\$[\d,.]+)$/, (m) => `${m[1]}-е ${m[3]}`],
    [/^(\$[\d,.]+)\((\d+)(st|nd|rd|th)\)$/, (m) => `${m[1]}(${m[2]}-е)`],
    [/^you · won (\$[\d,.]+)$/, (m) => `ты · выиграл ${m[1]}`],
    [/^· (\d+) players · prize pool (\$[\d,.]+)( · test)?$/, (m) => `· игроков: ${m[1]} · фонд ${m[2]}${m[3] ? " · пробный" : ""}`],
    [/^(\d+) of (\d+) left$/, (m) => `осталось ${m[1]} из ${m[2]}`],
    [/^(\d+) left$/, (m) => `осталось ${m[1]}`],
    [/^avg (.+)$/, (m) => `средний ${m[1]}`],
    [/^Level (\d+)$/, (m) => `Уровень ${m[1]}`],
    [/^next: (.+) in$/, (m) => `дальше: ${m[1]} через`],
    [/^You · table (\d+)$/, (m) => `Ты · стол ${m[1]}`],
    [/^(\d+) BB · place (\d+) of (\d+) · avg (.+)$/, (m) => `${m[1]} BB · место ${m[2]} из ${m[3]} · средний ${m[4]}`],
    [/^(\d+)(st|nd|rd|th) place$/, (m) => `${m[1]}-е место`],
    [/^(\d+)(st|nd|rd|th)( 🏆)?$/, (m) => `${m[1]}-е${m[3] || ""}`],
    [/^You finished (\d+)(st|nd|rd|th)$/, (m) => `Ты на ${m[1]}-м месте`],
    [/^in (\d+) days$/, (m) => `через ${m[1]} дн.`],
    [/^running · level (\d+) · (\d+) left$/, (m) => `идёт · уровень ${m[1]} · осталось ${m[2]}`],
    [/^(.+) chips$/, (m) => `${m[1]} фишек`],
    [/^(\d+)-min levels$/, (m) => `уровни по ${m[1]} мин`],
    [/^ante from lvl (\d+)$/, (m) => `анте с ур. ${m[1]}`],
    [/^late reg to lvl (\d+)$/, (m) => `поздняя рег. до ур. ${m[1]}`],
    [/^rebuys to lvl (\d+)$/, (m) => `ребаи до ур. ${m[1]}`],
    [/^(\d) per table$/, (m) => `${m[1]} за столом`],
    [/^(\d+) of (\d+)$/, (m) => `${m[1]} из ${m[2]}`],
    [/^· (\d+) players( · test)?$/, (m) => `· игроков: ${m[1]}${m[2] ? " · пробный" : ""}`],
    [/^· (\d+) pts$/, (m) => `· ${m[1]} очков`],
    [/^you · \+(\d+) pts$/, (m) => `ты · +${m[1]} очков`],
    [/^(MON|TUE|WED|THU|FRI|SAT|SUN)$/, (m) => ({ MON: "ПН", TUE: "ВТ", WED: "СР", THU: "ЧТ", FRI: "ПТ", SAT: "СБ", SUN: "ВС" })[m[1]]],
    [/^(\d{1,2}) (JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)$/, (m) => `${m[1]} ${({ JAN: "ЯНВ", FEB: "ФЕВ", MAR: "МАР", APR: "АПР", MAY: "МАЯ", JUN: "ИЮН", JUL: "ИЮЛ", AUG: "АВГ", SEP: "СЕН", OCT: "ОКТ", NOV: "НОЯ", DEC: "ДЕК" })[m[2]]}`],
    [/^Level (\d+) of (\d+)$/, (m) => `Уровень ${m[1]} из ${m[2]}`],
    [/^Next: (.+)$/, (m) => `Дальше: ${m[1]}`],
    [/^(\d+) \/ (\d+) left$/, (m) => `осталось ${m[1]} из ${m[2]}`],
    [/^(\d+) registered$/, (m) => `записано: ${m[1]}`],
    [/^registered \(max (\d+)\)$/, (m) => `записано (максимум ${m[1]})`],
    [/^by stack · (\d+) of (\d+) left$/, (m) => `по стеку · осталось ${m[1]} из ${m[2]}`],
    [/^average stack · (\d+) BB$/, (m) => `средний стек · ${m[1]} BB`],
    [/^(\d+)(st|nd|rd|th) · out at level (.+)$/, (m) => `${m[1]}-е место · вылет на уровне ${m[3]}`],
    [/^started (\d\d:\d\d) · (\d) per table$/, (m) => `начался в ${m[1]} · ${m[2]} за столом`],
    [/^(.+) · (\d) per table( · test)?$/, (m) => `${T(m[1])} · ${m[2]} за столом${m[3] ? " · пробный" : ""}`],
    [/^\((\d+) rebuys?\)$/, (m) => `(ребаев: ${m[1]})`],
    [/^Extend to level (\d+)$/, (m) => `Продлить до уровня ${m[1]}`],
    [/^Reopen until level (\d+)$/, (m) => `Открыть снова до уровня ${m[1]}`],
    [/^🕑 Late registration open until the end of level (\d+)\.$/, (m) => `🕑 Поздняя регистрация открыта до конца уровня ${m[1]}.`],
    [/^🕑 Late registration closed after level (\d+)\.$/, (m) => `🕑 Поздняя регистрация закрыта после уровня ${m[1]}.`],
    [/^Restored after a restart — continues by itself in (\d+) min, or press Resume\.$/, (m) => `Восстановлен после перезапуска — продолжится сам через ${m[1]} мин, или нажми «Продолжить».`],
    [/^Remove (.+)\? Their chips leave the game and they finish in the next place out\.$/, (m) => `Убрать ${m[1]}? Его фишки уйдут из игры, а место будет как у следующего вылетевшего.`],
    [/^(.+) removed\.$/, (m) => `${m[1]} убран.`],
    [/^Watch table (\d+)$/, (m) => `Смотреть стол ${m[1]}`],
    [/^Remove (.+)$/, (m) => `Убрать ${m[1]}`],
    [/^(\d+) players are still in\. Hands stop, nobody gets (points|prizes) or the trophy\. Can't be undone\.$/, (m) => `В игре ещё ${m[1]}. Раздачи остановятся, призов и кубка никто не получит. Отменить нельзя.`],
    [/^(\d+) players are registered\. Registration closes and nobody plays\. Can't be undone\.$/, (m) => `Записано: ${m[1]}. Регистрация закроется, никто не сыграет. Отменить нельзя.`],
    [/^~(.+)$/, (m) => "~" + m[1].replace(/ h /, " ч ").replace(/ m$/, " м").replace(/ min$/, " мин")],
    [/^usually (.+) – (.+) with (\d+) players$/, (m) => `обычно ${m[1]} – ${m[2]} при ${m[3]} игроках`],
    [/^≈ (.+) after start$/, (m) => `≈ ${m[1].replace(/ h /, " ч ").replace(/ m$/, " м").replace(/ min$/, " мин")} после старта`],
    [/^= (.+) BB at level 1$/, (m) => `= ${m[1]} BB на 1-м уровне`],
    [/^(\d+) players → (\d+) tables of (\d+)\. When (\d+) are left, they move to one final table\.$/, (m) => `${m[1]} игроков → ${m[2]} стола по ${m[3]}. Когда останется ${m[4]}, все пересядут за финальный стол.`],
    [/^(\d+) players → one table\.$/, (m) => `${m[1]} игроков → один стол.`],
    [/^Changed (\d+) fields?\.$/, (m) => `Изменено полей: ${m[1]}.`],
    [/^Level (\d+): ante (.+) is less than 1\/10 of BB — that's fine, just checking it's not a typo\.$/, (m) => `Уровень ${m[1]}: анте ${m[2]} меньше 1/10 BB — это нормально, просто проверь, что не опечатка.`],
    [/^Level (\d+): SB must be more than 0 and less than BB\.$/, (m) => `Уровень ${m[1]}: SB должен быть больше 0 и меньше BB.`],
    [/^Level (\d+): blinds go down\.$/, (m) => `Уровень ${m[1]}: блайнды уменьшаются.`],
    [/^(\d+) × (\d+) min$/, (m) => `${m[1]} × ${m[2]} мин`],
    [/^(\d+) min$/, (m) => `${m[1]} мин`],
    [/^to level (\d+) · (.+)$/, (m) => `до ур. ${m[1]} · ${m[2].replace("to level", "до ур.").replace(/^no$/, "нет")}`],
    [/^no · (.+)$/, (m) => `нет · ${m[1].replace("to level", "до ур.").replace(/^no$/, "нет")}`],
    [/^level (\d+)$/, (m) => `уровень ${m[1]}`],
    [/^(Hold'em|Omaha), (\d) per table$/, (m) => `${m[1]}, ${m[2]} за столом`],
    [/^(\d+) pts \+ 🏆$/, (m) => `${m[1]} очков + 🏆`],
    [/^(\d+) pts( 🏆)?$/, (m) => `${m[1]} очков${m[2] || ""}`],
    [/^(Hold'em|Omaha) · (.+) chips · (\d+)-min levels(.*)$/, (m) => `${m[1]} · ${m[2]} фишек · уровни по ${m[3]} мин` +
      m[4].replace(/ · ante from the start/, " · анте с первого уровня").replace(/ · ante from level (\d+)/, " · анте с ур. $1").replace(/ · rebuys to level (\d+)/, " · ребаи до ур. $1").replace(" · test", " · пробный")],
    [/^Welcome back, (.+)!$/, (m) => `С возвращением, ${m[1]}!`],
    [/^(.+) won the tournament (.+) and (\$[\d,.]+)$/, (m) => `${m[1]} выиграл турнир ${m[2]} и ${m[3]}`],
    [/^(.+) won the tournament (.+)$/, (m) => `${m[1]} выиграл турнир ${m[2]}`],
    [/^(.+) is waiting for an opponent$/, (m) => `${m[1]} ждёт соперника`],
    [/^(.+) is waiting — needs 1 more$/, (m) => `${m[1]} ждёт — нужен ещё 1`],
    [/^(\d+) playing$/, (m) => `${m[1]} играют`],
    [/^(.+) tables$/, (m) => `${m[1]} — столы`],
    [/^playing · (.+)$/, (m) => `играет · ${m[1]}`],
    [/^sitting out · (.+)$/, (m) => `отошёл · ${m[1]}`],
    [/^watching · (.+)$/, (m) => `смотрит · ${m[1]}`],
    [/^Go to (.+)$/, (m) => `Перейти: ${m[1]}`],
    [/^· just you$/, () => "· только ты"],
    [/^· you are #(\d+)$/, (m) => `· ты №${m[1]}`],
    [/^Full table( \((\d+)\))? →$/, (m) => `Вся таблица${m[1] || ""} →`],
    [/^since (.+)$/, (m) => `с ${T(m[1])}`],
    [/^(.+) — profile menu$/, (m) => `${m[1]} — меню профиля`],
    [/^(.+) \((\d+) seats\) is empty — for when (.+) fills up\.$/, (m) => `${m[1]} (${m[2]} мест) пуст — на случай, когда заполнится ${m[3]}.`],
    [/^(.+) \((\d+) seats\) is empty\.$/, (m) => `${m[1]} (${m[2]} мест) пуст.`],
    [/^Seats you at the busiest table with a free seat — now$/, () => "Посадит за самый людный стол со свободным местом — сейчас это"],
    [/^\((\d+) playing, (\d+) free\)\.$/, (m) => `(играют ${m[1]}, свободно ${m[2]}).`],
    [/^Nobody is playing yet — start a game at$/, () => "Пока никто не играет — начни игру за столом"],
    [/^(.+) · (\d+) seats$/, (m) => `${m[1]} · ${m[2]} мест`],
    [/^(.+) · 1 vs 1$/, (m) => `${m[1]} · 1 на 1`],
    [/^· buy-in (.+)$/, (m) => `· бай-ин ${m[1]}`],
    [/^buy-in from (.+)$/, (m) => `бай-ин от ${m[1]}`],
    [/^(.+\.) · blinds (\d[\d,]*\/\d[\d,]*)$/, (m) => `${T(m[1])} · блайнды ${m[2]}`],
    [/^Delete message from (.+)$/, (m) => `Удалить сообщение от ${m[1]}`],
    [/^joined (\S+)( · seen (.+))?$/, (m) => `с ${m[1]}` + (m[2] ? ` · был ${T(m[3])}` : "")],
    [/^just now$/, () => "только что"],
    [/^(\d+) min ago$/, (m) => `${m[1]} мин назад`],
    [/^(\d+) h ago$/, (m) => `${m[1]} ч назад`],
    [/^(\d+) days ago$/, (m) => `${m[1]} дн назад`],
    [/^· (\d+)$/, (m) => `· ${m[1]}`],
    [/^Reset the password of (.+)\? They get a new temporary password and are logged out everywhere\.$/,
      (m) => `Сбросить пароль игроку ${m[1]}? Он получит новый временный пароль, и его выкинет со всех устройств.`],
    [/^New password for (.+) — send it to them\. They can change it in their profile\.$/,
      (m) => `Новый пароль для ${m[1]} — отправь ему. Сменить его можно в профиле.`],
    [/^Delete the account (.+)\? Their stats and photo are deleted too\. This can't be undone\.$/,
      (m) => `Удалить аккаунт ${m[1]}? Статистика и фото тоже удалятся. Отменить нельзя.`],
    [/^(.+) deleted\.$/, (m) => `${m[1]} удалён.`],
    [/^⬆ New version on GitHub · (\d+) changes?$/, (m) => `⬆ Новая версия на GitHub · изменений: ${m[1]}`],
    [/^⏳ Updating to (\w+) as soon as the tables are empty \((.+) seated now\)…$/, (m) => `⏳ Обновлю до ${m[1]}, как только столы опустеют (сейчас сидят: ${m[2]})…`],
    [/^⚙ Installing (\w+)…$/, (m) => `⚙ Ставлю ${m[1]}…`],
    [/^✓ Site is up to date · version (\w+)$/, (m) => `✓ На сайте последняя версия · ${m[1]}`],
    [/^✓ Updated to (\w+)\. \((.+)\)$/, (m) => `✓ Обновлено до ${m[1]}. (${T(m[2])})`],
    // стол
    [/^All (\d+) seats are taken\. You can watch the game\.$/, (m) => `Все ${m[1]} мест заняты. Можно смотреть игру.`],
    [/^You will sit as "(.+)"\.$/, (m) => `Ты сядешь как «${m[1]}».`],
    [/^Minimum (.+)\. Blinds (.+)\.$/, (m) => `Минимум ${m[1]}. Блайнды ${m[2]}.`],
    [/^Blinds (.+)\.$/, (m) => `Блайнды ${m[1]}.`],
    [/^Minimum buy-in (.+)$/, (m) => `Минимальный бай-ин ${m[1]}`],
    [/^Minimum (.+) chips\.$/, (m) => `Минимум ${m[1]} фишек.`],
    [/^Maximum (.+) chips\.$/, (m) => `Максимум ${m[1]} фишек.`],
    [/^Minimum (.+)$/, (m) => `Минимум ${m[1]}`],
    [/^Choose (.+) chips\.$/, (m) => `Выбери ${m[1]} фишек.`],
    [/^All (\d+) seats are taken\.$/, (m) => `Все ${m[1]} мест заняты.`],
    [/^You are already sitting at (.+)\. Leave that table first\.$/, (m) => `Ты уже сидишь за столом ${m[1]}. Сначала выйди из-за него.`],
    [/^Hand #(\d+)$/, (m) => `Раздача №${m[1]}`],
    [/^— Hand #(\d+) —$/, (m) => `— Раздача №${m[1]} —`],
    [new RegExp(`^Pot ${A}$`), (m) => `Банк ${m[1]}`],
    [new RegExp(`^(\\d\\d:\\d\\d) · pot ${A}$`), (m) => `${m[1]} · банк ${m[2]}`],
    [new RegExp(`^(.+) · blinds ${A}/${A} · pot ${A}$`), (m) => `${T(m[1])} · блайнды ${m[2]}/${m[3]} · банк ${m[4]}`],
    [new RegExp(`^left · ${A}$`), (m) => `ушёл · ${m[1]}`],
    [/^rebuying… (\d+)s$/, (m) => `докупается… ${m[1]} с`],
    [/^(.+) lost with (\d+)%$/, (m) => `${m[1]} проиграл с ${m[2]}%`],
    [/^Time bank: (\d+)s left \(preflop\)$/, (m) => `Запас времени: ${m[1]} с (префлоп)`],
    [/^Time bank: (\d+)s left for the flop, turn and river$/, (m) => `Запас времени: ${m[1]} с на флоп, тёрн и ривер`],
    [/^Can no longer win on board (\d)$/, (m) => `Уже не может выиграть на доске ${m[1]}`],
    [/^Chance to win half the pot on board (\d): (.+)$/, (m) => `Шанс выиграть половину банка на доске ${m[1]}: ${m[2]}`],
    [/^Chance to win the pot: (.+)$/, (m) => `Шанс выиграть банк: ${m[1]}`],
    [/^(.+) \d+\/\d+ — NoDiddyPoker$/, null],          // заголовок вкладки: название стола не переводим
    [new RegExp(`^Returned ${A}$`), (m) => `Вернули ${m[1]}`],
    [new RegExp(`^(.+): uncalled ${A} returned\\.$`), (m) => `${m[1]}: неуравненные ${m[2]} вернулись.`],
    [new RegExp(`^(.+) takes the pot ${A}\\.?$`), (m) => `${m[1]} забирает банк ${m[2]}`],
    [new RegExp(`^(.+) gets back ${A}$`), (m) => `${m[1]} получает обратно ${m[2]}`],
    // итог банка: «Board 1 · Main pot 1,500: Petya and Dima split — Flush»
    [new RegExp(`^(Board ([12]) · )?(Pot|Main pot|Side pot \\d+) ${A}: (.+) (wins|split) — (.+)$`),
      (m) => `${m[1] ? `Доска ${m[2]} · ` : ""}${potName(m[3])} ${m[4]}: ${m[5].replace(/ and /g, " и ")} ${m[6] === "wins" ? "выигрывает" : "делят"} — ${hand(m[7])}`],
    [/^(.+) sits down with (.+)\.$/, (m) => `${m[1]} садится с ${m[2]}.`],
    [/^Reshuffle: no seed from (.+)\.$/, (m) => `Мешаем заново: нет секрета от ${m[1]}.`],
    [/^(.+) leaves the table \((.+)\)\.$/, (m) => `${m[1]} выходит из-за стола (${m[2]}).`],
    [/^(.+) rebuys (.+)\.$/, (m) => `${m[1]} докупается на ${m[2]}.`],
    [/^(.+) shows (.+)\.$/, (m) => `${m[1]} показывает ${m[2]}.`],
    [/^(.+) starts a new results count\.$/, (m) => `${m[1]} начинает подсчёт заново.`],
    [/^Bad beat! (.+) loses with (\d+)%\.$/, (m) => `Bad beat! ${m[1]} проигрывает с ${m[2]}%.`],
    [/^(.+) uses the time bank \((\d+)s left\)\.$/, (m) => `${m[1]} берёт запас времени (осталось ${m[2]} с).`],
    [/^(.+) did not come back from the lobby and sits out\.$/, (m) => `${m[1]} не вернулся из лобби и пропускает раздачи.`],
    [/^(.+) missed two turns and sits out\.$/, (m) => `${m[1]} пропустил два хода и пропускает раздачи.`],
    [/^(.+) left the website and leaves the table\.$/, (m) => `${m[1]} ушёл с сайта и вышел из-за стола.`],
    [/^(.+) \(time\)$/, (m) => `${T(m[1])} (время)`],
    [/^(\S+ \/ \S.*)$/, (m) => (m[1].split(" / ").every((x) => RU[x]) ? hand(m[1]) : null)],   // «Flush / Two pair»
  ];

  // Перевод одной строки (вокруг — пробелы как были). Неизвестное остаётся по-английски.
  function T(s) {
    if (lang !== "ru" || s == null) return s;
    s = String(s);
    if (!/[A-Za-z]/.test(s)) return s;
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s);
    const core = m[2];
    let out = RU[core];
    if (out === undefined) {
      for (const [re, fn] of PATTERNS) {
        const r = re.exec(core);
        if (r) { out = fn ? fn(r) : core; if (out != null) break; }
      }
    }
    const pre = /^(: |🏆 |⚠ )/.exec(core);                      // «: Call 100», «🏆 Pot …», «⚠ Level 3: …» — перевести хвост
    if (out == null && pre) {
      const tail = T(core.slice(pre[1].length));
      if (tail !== core.slice(pre[1].length)) out = pre[1] + tail;
    }
    return out == null ? s : m[1] + out + m[3];
  }

  // ---------- перевод того, что на экране ----------
  const ATTRS = ["placeholder", "title", "aria-label"];
  const orig = new WeakMap();          // текстовый узел -> {en, shown}
  const origAttr = new WeakMap();      // элемент -> {attr: {en, shown}}
  const skip = (node) => {
    const elm = node.nodeType === 1 ? node : node.parentElement;
    return !elm || Boolean(elm.closest("[data-notr], script, style, textarea, input"));
  };
  function doText(node) {
    if (skip(node)) return;
    let rec = orig.get(node);
    if (!rec || node.data !== rec.shown) { rec = { en: node.data, shown: node.data }; orig.set(node, rec); }   // текст поменяла страница
    const want = lang === "ru" ? T(rec.en) : rec.en;
    if (node.data !== want) node.data = want;
    rec.shown = want;
  }
  function doAttrs(elm) {
    if (elm.nodeType !== 1 || elm.closest("[data-notr]")) return;
    let recs = origAttr.get(elm);
    for (const a of ATTRS) {
      if (!elm.hasAttribute(a)) continue;
      if (!recs) { recs = {}; origAttr.set(elm, recs); }
      const v = elm.getAttribute(a);
      let rec = recs[a];
      if (!rec || v !== rec.shown) { rec = { en: v, shown: v }; recs[a] = rec; }
      const want = lang === "ru" ? T(rec.en) : rec.en;
      if (v !== want) elm.setAttribute(a, want);
      rec.shown = want;
    }
  }
  function walk(root) {
    if (root.nodeType === 3) { doText(root); return; }
    if (root.nodeType !== 1) return;
    doAttrs(root);                     // подсказки у полей ввода тоже переводим
    if (skip(root)) return;
    const it = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let n;
    while ((n = it.nextNode())) n.nodeType === 3 ? doText(n) : doAttrs(n);
  }
  let busy = false;
  const observer = new MutationObserver((list) => {
    if (busy) return;
    busy = true;
    try {
      for (const m of list) {
        if (m.type === "characterData") doText(m.target);
        else if (m.type === "attributes") doAttrs(m.target);
        else m.addedNodes.forEach(walk);
      }
      observer.takeRecords();          // наши собственные правки — не обрабатывать второй раз
    } finally { busy = false; }
  });
  function translateTitle() {
    const t = document.querySelector("title");
    if (!t) return;
    if (t.dataset.en === undefined || (t.textContent !== t.dataset.shown)) t.dataset.en = t.textContent;
    const want = lang === "ru" ? T(t.dataset.en) : t.dataset.en;
    if (t.textContent !== want) t.textContent = want;
    t.dataset.shown = want;
  }
  function start() {
    busy = true;
    walk(document.body);
    translateTitle();
    busy = false;
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    const tObs = new MutationObserver(translateTitle);
    const t = document.querySelector("title");
    if (t) tObs.observe(t, { childList: true, characterData: true, subtree: true });
    mountSwitch();
  }

  // ---------- кнопка EN / RU ----------
  function mountSwitch() {
    const spot = document.getElementById("langspot");
    if (!spot) return;
    const box = document.createElement("div");
    box.className = "langsw";
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", "Language");
    for (const code of ["en", "ru"]) {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.lang = code;
      b.textContent = code.toUpperCase();
      b.setAttribute("data-notr", "");
      b.title = code === "en" ? "English" : "Русский";
      b.onclick = () => setLang(code);
      box.append(b);
    }
    spot.replaceChildren(box);
    paintSwitch();
  }
  function paintSwitch() {
    document.querySelectorAll(".langsw button").forEach((b) => {
      const on = b.dataset.lang === lang;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }
  function setLang(code) {
    lang = code === "ru" ? "ru" : "en";
    try { localStorage.setItem(KEY, lang); } catch (e) {}
    document.documentElement.lang = lang;
    busy = true;
    walk(document.body);
    translateTitle();
    observer.takeRecords();
    busy = false;
    paintSwitch();
  }

  document.documentElement.lang = lang;
  window.T = T;                         // для confirm() / prompt() — их текст не в странице
  window.i18n = { T, setLang, get lang() { return lang; } };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
