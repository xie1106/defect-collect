# -*- coding: utf-8 -*-
"""圆通电子面单 PDF 生成器（reportlab，按官方模板 1:1 复刻）
用法: python gen_facesheet.py data.json out.pdf
data.json 示例见 sample-data.json
"""
import json, sys, io
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.graphics.barcode import code128
from reportlab.lib.utils import ImageReader
import os

HERE = os.path.dirname(os.path.abspath(__file__))
FONT = r"C:\Windows\Fonts\simhei.ttf"   # 官方模板字体=黑体
ICON_RECV = os.path.join(HERE, "icons", "icon_recv.png")
ICON_SEND = os.path.join(HERE, "icons", "icon_send.png")
W, H = 213.0, 366.0  # 75.14 x 129.14 mm (pt)

def main():
    data = json.load(open(sys.argv[1], encoding="utf-8"))
    out = sys.argv[2] if len(sys.argv) > 2 else "facesheet.pdf"
    pdfmetrics.registerFont(TTFont("SimHei", FONT))
    c = canvas.Canvas(out, pagesize=(W, H))
    d = data

    def line(x0, y0, x1, y1, w=0.8):
        c.setLineWidth(w); c.line(x0, y0, x1, y1)

    def text(s, x, ytop, size):
        # ytop = PDF 顶部坐标(pt)，baseline = 366 - ytop - size*0.85
        c.setFillColorRGB(0, 0, 0); c.setFont("SimHei", size)
        c.drawString(x, 366 - ytop - size*0.85, s)

    def vtext(s, x, y, size, reverse=False):
        c.saveState(); c.setFont("SimHei", size)
        if reverse:
            c.translate(x + size*0.7, y); c.rotate(90)
            for ch in s: c.drawString(0, 0, ch); c.translate(size*1.1, 0)
        else:
            c.translate(x, y); c.rotate(90)
            for ch in reversed(s): c.drawString(0, 0, ch); c.translate(-size*1.1, 0)
        c.restoreState()

    mailno = d["mailNo"]; date = d["date"]; tm = d["time"]
    seg = d["seg"]; landmark = d.get("landmark", "")
    rn = d["receiver"]["name"]; rp = d["receiver"]["phone"]; ra = d["receiver"]["address"]
    sn = d["sender"]["name"]; sa = d["sender"]["address"]
    po = d.get("poId", ""); rows = d.get("rows", []); total = d.get("totalQty", 1)

    # 顶部
    text(mailno, 3.7, 15.3, 8)
    text(date, 2.8, 24.9, 7)
    text(tm + " 第1/1个", 56.9, 24.9, 7)
    line(14.4, 366-34, 198.5, 366-34)
    text(seg, 23.6, 34, 23)
    line(14.4, 366-59.5, 198.5, 366-59.5)

    # 条码
    bc = code128.Code128(mailno, barWidth=1.0, barHeight=30.8)
    bc.drawOn(c, 16.2, 366-93.3, 143.7/bc.width)

    # 大单号
    text(mailno, 32.7, 93.5, 11)
    line(14.4, 366-104.9, 164.5, 366-104.9)

    # 目的地
    c.setLineWidth(0.8); c.rect(16.0, 366-122.2, 19.7, 17.3)
    text(landmark, 36.9, 105.9, 15)
    line(14.4, 366-123.6, 164.5, 366-123.6)
    line(14.3, 366-138, 164.5, 366-138)

    # 收件人
    if os.path.exists(ICON_RECV):
        c.drawImage(ImageReader(ICON_RECV), 15.7, 366-151.5, 13.3, 11.4)
    text(rn, 27.3, 140.9, 9)
    text(rp, 27.3, 151.2, 9)
    y = 161.5
    for al in d["receiver"].get("addressLines", [ra]):
        text(al, 27.3, y, 9); y += 10.4
    line(14.3, 366-195.6, 164.5, 366-195.6)

    # 寄件人
    if os.path.exists(ICON_SEND):
        c.drawImage(ImageReader(ICON_SEND), 13.6, 366-210.3, 10.5, 12.7)
    text(sn, 25.2, 195.8, 12)
    text(sa, 25.2, 209.5, 12)
    line(14.4, 366-223.9, 199.3, 366-223.9)

    # 编码行
    text(d.get("code", ""), 2.2, 227.2, 9)
    text(d.get("qty", ""), 2.2, 236.6, 9)

    # 右侧竖排
    vbc = code128.Code128(mailno, barWidth=0.9, barHeight=21.7)
    c.saveState(); c.translate(176.4, 366-214.5); c.rotate(90)
    vbc.drawOn(c, 0, 0, 147.0/vbc.width); c.restoreState()
    vtext(mailno, 167.6, 366-177, 3.5)
    line(164.5, 366-223.9, 164.5, 366-59.8, 0.8)

    # 4 处边缘竖排
    vtext(mailno, 3.6, 366-107.9, 4)
    vtext(mailno, 4.3, 366-205.5, 4)
    vtext(mailno, 202.0, 366-107.7, 4, reverse=True)
    vtext(mailno, 202.2, 366-204.2, 4, reverse=True)

    # 合计 / 已验视
    text("合计 " + str(total), 149.4, 285.9, 9)
    text("已验视", 173.5, 292, 8)

    # 底部明细表
    ty = 0
    c.setLineWidth(0.8)
    c.line(2, ty+62, 211, ty+62)
    c.line(2, ty, 211, ty)
    text("采购单号   款号   颜色   码   数量", 3, 366-(ty+56), 9)
    yy = 366 - (ty + 62 - 12)
    for r in rows:
        text(f"{po}   {r[0]}   {r[1]}   {r[2]}   {r[3]}", 3, yy, 9)
        yy += 11

    c.showPage(); c.save()
    print("PDF saved:", out)

if __name__ == "__main__":
    main()
