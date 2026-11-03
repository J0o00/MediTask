window.Chart = class { constructor(_c, cfg) { (window.__charts ||= []).push(cfg); } destroy() {} };
window.jspdf = { jsPDF: class { constructor() { window.__pdf = []; } setFontSize() {} setTextColor() {} setDrawColor() {} line() {} addPage() {} splitTextToSize(t) { return [t]; } text(t) { window.__pdf.push(String(t)); } save(n) { window.__pdfSaved = n; } } };
