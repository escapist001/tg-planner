# -*- coding: utf-8 -*-
"""Карточка на один день: крупно, чтобы читалось с телефона без масштабирования."""
import json, io, os
from datetime import datetime, timedelta, timezone
from PIL import Image, ImageDraw, ImageFont, ImageFilter

MSK = timezone(timedelta(hours=3))
BASE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(BASE, 'days')
os.makedirs(OUT, exist_ok=True)

W = 1080
PAD = 56

BG_TOP = (10, 22, 34)
BG_BOT = (14, 30, 46)
CARD = (19, 36, 53)
CARD_EDGE = (32, 56, 78)
WHITE = (242, 247, 253)
GREY = (140, 160, 180)
DIM = (100, 122, 143)

LIME = (184, 255, 59)
CYAN = (77, 216, 255)
PINK = (255, 107, 214)
GOLD = (255, 209, 102)

WHO_COLOR = {'danya': LIME, 'zhenya': PINK, 'both': CYAN}
WHO_NAME = {'danya': 'Даня', 'zhenya': 'Женя', 'both': 'Вместе'}

WD_FULL = ['ПОНЕДЕЛЬНИК', 'ВТОРНИК', 'СРЕДА', 'ЧЕТВЕРГ', 'ПЯТНИЦА', 'СУББОТА', 'ВОСКРЕСЕНЬЕ']
MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
          'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря']

F = 'C:/Windows/Fonts/{}'
def font(name, size):
    return ImageFont.truetype(F.format(name), size)

FT_DAY = font('segoeuib.ttf', 132)
FT_MONTH = font('segoeui.ttf', 40)
FT_WD = font('segoeuib.ttf', 34)
FT_FOCUS = font('segoeuib.ttf', 30)
FT_TIME = font('segoeuib.ttf', 44)
FT_TASK = font('segoeui.ttf', 38)
FT_WHO = font('segoeuib.ttf', 24)
FT_FOOT = font('segoeui.ttf', 26)
FT_BIG = font('segoeuib.ttf', 96)
FT_NOTE = font('segoeui.ttf', 30)

WEDDING_DAY = datetime(2026, 8, 15).date()


def msk(iso):
    return datetime.fromisoformat(iso.replace('Z', '+00:00')).astimezone(MSK)


def expand(tasks, day):
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
        same = start.replace(year=day.year, month=day.month, day=day.day)
        if rule == 'daily':
            out.append((same, t))
        elif rule == 'weekdays' and day.weekday() < 5:
            out.append((same, t))
        elif rule.startswith('weekly:') and day.weekday() == (int(rule.split(':')[1]) - 1) % 7:
            out.append((same, t))
        elif rule.startswith('monthly:') and day.day == int(rule.split(':')[1]):
            out.append((same, t))
    out.sort(key=lambda x: (x[0].hour, x[0].minute))
    return out


def focus_of(items, day):
    if day == WEDDING_DAY:
        return 'СВАДЬБА', GOLD
    tags = [t.get('tag') for _, t in items]
    titles = ' '.join(t['title'].lower() for _, t in items)
    if tags.count('wedding') >= 2:
        return 'СВАДЬБА · ПОДГОТОВКА', GOLD
    if 'портфолио' in titles or 'резюме' in titles or 'визитк' in titles:
        return 'ПОРТФОЛИО', LIME
    if 'ателье' in titles:
        return 'АТЕЛЬЕ', CYAN
    if tags.count('content') >= 3:
        return 'КОНТЕНТ', PINK
    if not items:
        return 'СВОБОДНЫЙ ДЕНЬ', DIM
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


def gradient_bg(h):
    strip = Image.new('RGB', (1, h))
    for y in range(h):
        k = y / max(1, h - 1)
        strip.putpixel((0, y), tuple(int(BG_TOP[i] + (BG_BOT[i] - BG_TOP[i]) * k) for i in range(3)))
    img = strip.resize((W, h))
    glow = Image.new('RGB', (W, h), (0, 0, 0))
    ImageDraw.Draw(glow).ellipse([W - 420, -280, W + 260, 300], fill=(22, 60, 86))
    glow = glow.filter(ImageFilter.GaussianBlur(120))
    return Image.composite(Image.blend(img, glow, 0.6), img, Image.new('L', (W, h), 95))


def build_day(day, tasks, path):
    probe = ImageDraw.Draw(Image.new('RGB', (10, 10)))
    items = expand(tasks, day)
    focus, fcol = focus_of(items, day)
    is_wedding = day == WEDDING_DAY

    head = 300
    rows = []
    for start, t in items:
        lines = wrap(probe, t['title'], FT_TASK, W - 2 * PAD - 220)
        rows.append((start, t, lines))
    body = sum(max(96, 52 * len(l) + 44) for _, _, l in rows) if rows else 200
    if is_wedding:
        body = 320
    total = head + body + 150

    img = gradient_bg(total)
    d = ImageDraw.Draw(img)

    # шапка: крупное число и день недели
    d.text((PAD, 40), str(day.day), font=FT_DAY, fill=WHITE)
    num_w = probe.textlength(str(day.day), font=FT_DAY)
    d.text((PAD + num_w + 24, 78), MONTHS[day.month - 1], font=FT_MONTH, fill=GREY)
    d.text((PAD + num_w + 24, 130), WD_FULL[day.weekday()], font=FT_WD, fill=CYAN)

    # неоновая линия
    ly = 214
    for x in range(PAD, W - PAD):
        k = (x - PAD) / (W - 2 * PAD)
        d.line([(x, ly), (x, ly + 5)], fill=tuple(int(LIME[i] + (PINK[i] - LIME[i]) * k) for i in range(3)))

    d.text((PAD, ly + 26), focus, font=FT_FOCUS, fill=fcol)
    cnt = '' if is_wedding else f'{len(items)} дел' if len(items) % 10 != 1 or len(items) % 100 == 11 else f'{len(items)} дело'
    if len(items) % 10 in (2, 3, 4) and len(items) % 100 not in (12, 13, 14):
        cnt = f'{len(items)} дела'
    if not is_wedding:
        d.text((W - PAD - probe.textlength(cnt, font=FT_FOCUS), ly + 26), cnt, font=FT_FOCUS, fill=DIM)

    y = head
    if is_wedding:
        d.rounded_rectangle([PAD, y, W - PAD, y + 260], radius=28, fill=CARD, outline=GOLD, width=3)
        t1 = 'СВАДЬБА'
        d.text((W / 2 - probe.textlength(t1, font=FT_BIG) / 2, y + 60), t1, font=FT_BIG, fill=GOLD)
        t2 = 'Ни одного другого дела. Бот ведёт по таймлайну.'
        d.text((W / 2 - probe.textlength(t2, font=FT_NOTE) / 2, y + 180), t2, font=FT_NOTE, fill=GREY)
    elif not rows:
        d.rounded_rectangle([PAD, y, W - PAD, y + 150], radius=28, fill=CARD, outline=CARD_EDGE)
        t1 = 'Ничего не запланировано'
        d.text((W / 2 - probe.textlength(t1, font=FT_TASK) / 2, y + 52), t1, font=FT_TASK, fill=DIM)
    else:
        for start, t, lines in rows:
            rh = max(96, 52 * len(lines) + 44)
            col = WHO_COLOR.get(t['assignee'], CYAN)
            wed = t.get('tag') == 'wedding'
            d.rounded_rectangle([PAD, y, W - PAD, y + rh - 14], radius=24, fill=CARD,
                                outline=GOLD if wed else CARD_EDGE, width=2 if wed else 1)
            # цветная полоса слева — чьё дело
            d.rounded_rectangle([PAD + 14, y + 18, PAD + 24, y + rh - 32], radius=5, fill=col)

            d.text((PAD + 44, y + 20), f'{start.hour:02d}:{start.minute:02d}', font=FT_TIME, fill=WHITE)
            tx = PAD + 44 + 150
            for i, ln in enumerate(lines):
                d.text((tx, y + 22 + i * 52), ln, font=FT_TASK, fill=WHITE if i == 0 else GREY)

            who = WHO_NAME.get(t['assignee'], '')
            if wed:
                who += ' · свадьба'
            d.text((W - PAD - 24 - probe.textlength(who, font=FT_WHO), y + rh - 56),
                   who, font=FT_WHO, fill=GOLD if wed else col)
            y += rh

    if is_wedding:
        items = []
    dn = sum(1 for _, t in items if t['assignee'] == 'danya')
    zh = sum(1 for _, t in items if t['assignee'] == 'zhenya')
    bo = len(items) - dn - zh
    if is_wedding:
        d.text((PAD, total - 96), 'Главный день месяца', font=FT_FOOT, fill=GOLD)
    else:
        d.text((PAD, total - 96), f'Даня {dn}   ·   Женя {zh}   ·   вместе {bo}', font=FT_FOOT, fill=GREY)
    d.text((PAD, total - 56), 'День начинается в 12:00 · перенести можно кнопкой в боте',
           font=FT_FOOT, fill=DIM)

    img.save(path, 'PNG')
    return len(items)


def main():
    data = json.load(io.open(os.environ.get('TASKS_JSON', os.path.join(BASE, 'tasks.json')), encoding='utf-8'))
    tasks = data[0]['results']
    total = 0
    for dnum in range(3, 32):
        day = datetime(2026, 8, dnum).date()
        path = os.path.join(OUT, f'aug{dnum:02d}.png')
        n = build_day(day, tasks, path)
        total += n
        print('aug', dnum, ':', n)
    print('files:', len(os.listdir(OUT)), 'tasks total:', total)


if __name__ == '__main__':
    main()
