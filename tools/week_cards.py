# -*- coding: utf-8 -*-
"""Расписание на неделю картинкой: тёмный фон, неоновые акценты, карточки по дням."""
import json, io, os, math
from datetime import datetime, timedelta, timezone
from PIL import Image, ImageDraw, ImageFont, ImageFilter

MSK = timezone(timedelta(hours=3))
BASE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(BASE, 'weeks')
os.makedirs(OUT, exist_ok=True)

W = 900
PAD = 40

BG_TOP = (10, 22, 34)
BG_BOT = (13, 27, 42)
CARD = (18, 34, 50)
CARD_EDGE = (30, 52, 72)
WHITE = (240, 246, 252)
GREY = (128, 148, 168)
DIM = (96, 116, 136)

LIME = (184, 255, 59)
CYAN = (77, 216, 255)
PINK = (255, 107, 214)
GOLD = (255, 209, 102)
CORAL = (255, 122, 122)

WHO_COLOR = {'danya': LIME, 'zhenya': PINK, 'both': CYAN}
WHO_NAME = {'danya': 'Даня', 'zhenya': 'Женя', 'both': 'Вместе'}

WD_SHORT = ['ПН', 'ВТ', 'СР', 'ЧТ', 'ПТ', 'СБ', 'ВС']
MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
          'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря']

F = 'C:/Windows/Fonts/{}'
def font(name, size):
    return ImageFont.truetype(F.format(name), size)

FT_H1 = font('segoeuib.ttf', 54)
FT_EYEBROW = font('segoeuib.ttf', 20)
FT_SUB = font('segoeui.ttf', 24)
FT_DAYNUM = font('segoeuib.ttf', 34)
FT_DAYWD = font('segoeuib.ttf', 18)
FT_FOCUS = font('segoeuib.ttf', 20)
FT_TASK = font('segoeui.ttf', 25)
FT_TIME = font('segoeuib.ttf', 25)
FT_NOTE = font('segoeui.ttf', 20)
FT_FOOT = font('segoeui.ttf', 20)
FT_BADGE = font('segoeuib.ttf', 17)


def load_tasks(path):
    data = json.load(io.open(path, encoding='utf-8'))
    return data[0]['results']


def msk(iso):
    return datetime.fromisoformat(iso.replace('Z', '+00:00')).astimezone(MSK)


def expand(tasks, day):
    """Дела на конкретный день: разовые по дате плюс развёрнутые повторы."""
    out = []
    for t in tasks:
        if not t.get('due_at'):
            continue
        start = msk(t['due_at'])
        rule = t.get('repeat_rule')
        if not rule:
            if start.date() == day:
                out.append((start, t))
            continue
        if start.date() > day:
            continue
        if rule == 'daily':
            out.append((start.replace(year=day.year, month=day.month, day=day.day), t))
        elif rule == 'weekdays':
            if day.weekday() < 5:
                out.append((start.replace(year=day.year, month=day.month, day=day.day), t))
        elif rule.startswith('weekly:'):
            # 0 = воскресенье в формате проекта
            target = (int(rule.split(':')[1]) - 1) % 7
            if day.weekday() == target:
                out.append((start.replace(year=day.year, month=day.month, day=day.day), t))
        elif rule.startswith('monthly:'):
            if day.day == int(rule.split(':')[1]):
                out.append((start.replace(year=day.year, month=day.month, day=day.day), t))
    out.sort(key=lambda x: (x[0].hour, x[0].minute))
    return out


def focus_of(items, day):
    """Короткая подпись, чем занят день."""
    if day == datetime(2026, 8, 15).date():
        return 'СВАДЬБА', GOLD
    tags = [t.get('tag') for _, t in items]
    if tags.count('wedding') >= 2:
        return 'СВАДЬБА · ПОДГОТОВКА', GOLD
    titles = ' '.join(t['title'].lower() for _, t in items)
    if 'портфолио' in titles or 'резюме' in titles or 'визитк' in titles:
        return 'ПОРТФОЛИО', LIME
    if tags.count('content') >= 2:
        return 'КОНТЕНТ', PINK
    if 'ателье' in titles:
        return 'АТЕЛЬЕ', CYAN
    if tags.count('pets') >= 2:
        return 'ДОМ И ПИТОМЦЫ', CYAN
    if not items:
        return 'СВОБОДНО', DIM
    return 'ТЕКУЩИЕ ДЕЛА', CYAN


def wrap(draw, text, ft, width):
    words, lines, cur = text.split(), [], ''
    for w in words:
        probe = (cur + ' ' + w).strip()
        if draw.textlength(probe, font=ft) <= width:
            cur = probe
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def rounded(draw, box, r, fill, outline=None, width=1):
    draw.rounded_rectangle(box, radius=r, fill=fill, outline=outline, width=width)


def gradient_bg(h):
    img = Image.new('RGB', (W, h), BG_TOP)
    top = Image.new('RGB', (1, h))
    for y in range(h):
        k = y / max(1, h - 1)
        top.putpixel((0, y), tuple(int(BG_TOP[i] + (BG_BOT[i] - BG_TOP[i]) * k) for i in range(3)))
    img = top.resize((W, h))
    # мягкое световое пятно справа сверху
    glow = Image.new('RGB', (W, h), (0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([W - 320, -220, W + 220, 260], fill=(20, 54, 78))
    glow = glow.filter(ImageFilter.GaussianBlur(90))
    return Image.blend(img, Image.blend(img, glow, 0.0), 0.0) if False else Image.composite(
        Image.blend(img, glow, 0.55), img, Image.new('L', (W, h), 90))


WEDDING_DAY = datetime(2026, 8, 15).date()


def measure_day(draw, items, day=None):
    """Высота карточки дня."""
    if day == WEDDING_DAY:
        return 190
    h = 26
    for _, t in items:
        lines = wrap(draw, t['title'], FT_TASK, W - 2 * PAD - 200)
        h += max(34, 30 * len(lines))
    return max(112, h + 44)


def build_week(idx, days, tasks, title_range, path):
    probe = ImageDraw.Draw(Image.new('RGB', (10, 10)))
    day_items = {d: expand(tasks, d) for d in days}

    head_h = 250
    gap = 18
    body_h = sum(measure_day(probe, day_items[d], d) + gap for d in days)
    total = head_h + body_h + 120

    img = gradient_bg(total)
    d = ImageDraw.Draw(img)

    # шапка
    d.text((PAD, 54), f'НЕДЕЛЯ {idx:02d}', font=FT_EYEBROW, fill=CYAN)
    d.text((PAD, 84), 'ПЛАН НА НЕДЕЛЮ', font=FT_H1, fill=WHITE)
    d.text((PAD, 152), title_range, font=FT_SUB, fill=GREY)

    # неоновая линия
    line_y = 200
    for x in range(PAD, W - PAD):
        k = (x - PAD) / (W - 2 * PAD)
        col = tuple(int(LIME[i] + (PINK[i] - LIME[i]) * k) for i in range(3))
        d.line([(x, line_y), (x, line_y + 4)], fill=col)

    # легенда
    lx = PAD
    for who in ('danya', 'zhenya', 'both'):
        col = WHO_COLOR[who]
        d.ellipse([lx, line_y + 24, lx + 14, line_y + 38], fill=col)
        name = WHO_NAME[who]
        d.text((lx + 22, line_y + 20), name, font=FT_BADGE, fill=GREY)
        lx += 26 + int(probe.textlength(name, font=FT_BADGE)) + 34
    d.ellipse([lx, line_y + 24, lx + 14, line_y + 38], fill=CARD, outline=GOLD, width=3)
    d.text((lx + 22, line_y + 20), 'свадьба', font=FT_BADGE, fill=GREY)

    y = head_h
    for day in days:
        items = day_items[day]
        ch = measure_day(probe, items, day)
        is_wedding = day == datetime(2026, 8, 15).date()
        focus, fcol = focus_of(items, day)

        edge = GOLD if is_wedding else CARD_EDGE
        rounded(d, [PAD, y, W - PAD, y + ch], 22, CARD, outline=edge, width=2 if is_wedding else 1)

        # бейдж даты
        bx0, by0 = PAD + 18, y + 18
        bw, bh = 96, 74
        badge = GOLD if is_wedding else (LIME if day.weekday() < 5 else CYAN)
        rounded(d, [bx0, by0, bx0 + bw, by0 + bh], 16, badge)
        ds = f'{day.day:02d}.{day.month:02d}'
        d.text((bx0 + bw / 2 - probe.textlength(ds, font=FT_DAYNUM) / 2, by0 + 8),
               ds, font=FT_DAYNUM, fill=(8, 20, 30))
        wd = WD_SHORT[day.weekday()]
        d.text((bx0 + bw / 2 - probe.textlength(wd, font=FT_DAYWD) / 2, by0 + 46),
               wd, font=FT_DAYWD, fill=(8, 20, 30))

        tx = bx0 + bw + 24
        d.text((tx, y + 20), focus, font=FT_FOCUS, fill=fcol)

        # счётчик дел справа
        cnt = '' if is_wedding else f'{len(items)}'
        d.text((W - PAD - 26 - probe.textlength(cnt, font=FT_FOCUS), y + 20),
               cnt, font=FT_FOCUS, fill=DIM)

        if is_wedding:
            d.text((tx, y + 58), 'СВАДЬБА', font=FT_H1, fill=GOLD)
            d.text((tx, y + 122), 'Рутина молчит весь день. Бот ведёт по таймлайну.',
                   font=FT_NOTE, fill=GREY)
            y += ch + gap
            continue

        ty = y + 52
        if not items:
            d.text((tx, ty), 'Ничего не запланировано', font=FT_TASK, fill=DIM)
        for start, t in items:
            col = WHO_COLOR.get(t['assignee'], CYAN)
            if t.get('tag') == 'wedding':
                d.ellipse([tx - 4, ty + 6, tx + 14, ty + 24], outline=GOLD, width=3)
            d.ellipse([tx, ty + 10, tx + 10, ty + 20], fill=col)
            hm = f'{start.hour:02d}:{start.minute:02d}'
            d.text((tx + 22, ty), hm, font=FT_TIME, fill=WHITE)
            offset = tx + 22 + 78
            lines = wrap(d, t['title'], FT_TASK, W - PAD - offset - 30)
            for i, ln in enumerate(lines):
                d.text((offset, ty + i * 30), ln, font=FT_TASK, fill=WHITE if i == 0 else GREY)
            ty += max(34, 30 * len(lines))

        y += ch + gap

    # футер
    total_tasks = sum(len(day_items[d0]) for d0 in days)
    dn = sum(1 for d0 in days for _, t in day_items[d0] if t['assignee'] == 'danya')
    zh = sum(1 for d0 in days for _, t in day_items[d0] if t['assignee'] == 'zhenya')
    bo = total_tasks - dn - zh
    foot = f'Всего {total_tasks} · Даня {dn} · Женя {zh} · вместе {bo}'
    d.text((PAD, total - 76), foot, font=FT_FOOT, fill=GREY)
    d.text((PAD, total - 46), 'День начинается в 12:00 · перенести можно кнопкой в боте',
           font=FT_FOOT, fill=DIM)

    img.save(path, 'PNG')
    return path, total_tasks


def main():
    tasks = load_tasks(os.environ.get('TASKS_JSON', os.path.join(BASE, 'tasks.json')))
    weeks = [
        (1, [datetime(2026, 8, d).date() for d in range(3, 10)], '3–9 августа · старт'),
        (2, [datetime(2026, 8, d).date() for d in range(10, 17)], '10–16 августа · свадебная'),
        (3, [datetime(2026, 8, d).date() for d in range(17, 24)], '17–23 августа · после свадьбы'),
        (4, [datetime(2026, 8, d).date() for d in range(24, 32)], '24–31 августа · финиш месяца'),
    ]
    for idx, days, label in weeks:
        path = os.path.join(OUT, f'week{idx}.png')
        p, n = build_week(idx, days, tasks, label, path)
        print('week', idx, ':', n, 'del ->', p)


if __name__ == '__main__':
    main()
