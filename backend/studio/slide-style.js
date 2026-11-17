
(() => {
  const NS = "http://www.w3.org/2000/svg";
  function apply(node, element) {
    if (element.kind === "shape" && Number.isInteger(element.rotation) && element.rotation >= 0 && element.rotation <= 360) {
      node.style.rotate = element.rotation + "deg";
    }
    if (element.font_family) node.style.fontFamily = element.font_family;
    if (element.font_size) node.style.fontSize = (element.font_size / 12.8) + "cqw";
    if (element.text_color) node.style.color = element.text_color;
  }
  function appendText(node, value, ranges, offset = 0) {
    let cursor = 0;
    for (const range of ranges || []) {
      const start = Math.max(0, range.start - offset);
      const end = Math.min(value.length, range.end - offset);
      if (start >= end) continue;
      node.append(value.slice(cursor, start));
      const span = document.createElement("span");
      if (range.bold) span.style.fontWeight = "bold";
      if (range.italic) span.style.fontStyle = "italic";
      if (range.underline) span.style.textDecoration = "underline";
      if (/^#[0-9a-f]{6}$/i.test(range.text_color)) span.style.color = range.text_color;
      span.textContent = value.slice(start, end);
      node.append(span);
      cursor = end;
    }
    node.append(value.slice(cursor));
  }
  function text(node, element) {
    if (element.bold) node.style.fontWeight = "bold";
    if (element.italic) node.style.fontStyle = "italic";
    if (element.underline) node.style.textDecoration = "underline";
    if (element.text_align) node.style.textAlign = element.text_align;
    if (!element.list_style) {
      const content = document.createElement("span");
      content.style.width = "100%";
      appendText(content, element.text || "", element.text_ranges);
      node.append(content);
      return;
    }
    const list = document.createElement(element.list_style === "numbered" ? "ol" : "ul");
    Object.assign(list.style, { width: "100%", margin: "0", paddingInlineStart: "1.7em" });
    for (const match of (element.text || "").matchAll(/[^\r\n]+/g)) {
      const [line] = match;
      if (!line.trim()) continue;
      const item = document.createElement("li");
      appendText(item, line, element.text_ranges, match.index);
      list.append(item);
    }
    node.append(list);
  }
  function shape(element) {
    const svg = document.createElementNS(NS,"svg");
    svg.setAttribute("viewBox","0 0 100 100");
    svg.setAttribute("preserveAspectRatio","none");
    svg.setAttribute("aria-hidden","true");
    svg.classList.add("element-vector");
    const [tag, attributes] = {
      rectangle:["rect",{x:2,y:2,width:96,height:96,rx:3}],
      circle:["ellipse",{cx:50,cy:50,rx:48,ry:48}],
      arrow:["polygon",{points:"2,28 67,28 67,3 98,50 67,97 67,72 2,72"}],
      line:["line",{x1:2,y1:50,x2:98,y2:50}]
    }[element.shape || "rectangle"];
    const vector = document.createElementNS(NS,tag);
    for (const [key,value] of Object.entries(attributes)) vector.setAttribute(key,String(value));
    vector.setAttribute("fill",tag === "line" ? "none" : element.fill_color || "#d5e6ff");
    vector.setAttribute("fill-opacity",String((element.fill_opacity ?? 100)/100));
    vector.setAttribute("stroke",element.border_color || "#7aa6dd");
    vector.setAttribute("stroke-opacity",String((element.border_opacity ?? 100)/100));
    vector.setAttribute("stroke-width",String(element.border_width ?? 2));
    vector.setAttribute("vector-effect","non-scaling-stroke");
    svg.append(vector);
    return svg;
  }
  function table(element) {
    const grid = document.createElement("table");
    grid.className = "slide-table";
    if (element.text) grid.setAttribute("aria-label",element.text);
    (element.cells || []).forEach((values, index) => {
      const row = grid.insertRow();
      const heading = element.header_row !== false && index === 0;
      for (const value of values) {
        const cell = document.createElement(heading ? "th" : "td");
        if (heading) cell.scope = "col";
        cell.textContent = value;
        row.append(cell);
      }
    });
    return grid;
  }
  function audioLabel(element) {
    const label = (element.text || "").trim();
    return label ? "▶ " + label : "🔊";
  }
  window.REHSlideStyle = {apply,text,shape,table,audioLabel};
})();
