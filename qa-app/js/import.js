/* ==========================================================
   import.js — dedicated Import page (Excel / CSV -> Test Case)
   Reuses TestCaseModule.importFile so there is one source of truth.
   ========================================================== */

const ImportPage = {
  /* Styled .xlsx template, same look as TestCaseModule.exportExcel:
     header fill, borders + wrap text, dropdown on Type Test / Status. */
  async downloadTemplate(){
    const REQUIRED = ['module', 'scenario']; // what importFile() needs; shown as "Module *"
    const cols = TestCaseModule.exportColumns().filter(c => c.key !== 'code')
      .map(c => REQUIRED.includes(c.key) ? { ...c, label: `${c.label} *` } : c);
    const sample = {
      module:'Login', roleUser:'Customer', scenario:'Login dengan kredensial valid',
      testCase:'Verifikasi login sukses dengan email & password valid',
      preconditions:'User terdaftar', steps:'1. Buka app\n2. Input email/password\n3. Klik Login',
      testData:'email: user@test.com / password: Test1234', typeTest:'Positive',
      expectedResult:'User masuk ke Dashboard'
    };

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Template');
    ws.columns = cols.map(c => ({ header: c.label, key: c.key, width: c.width }));

    const headerRow = ws.getRow(1);
    headerRow.eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F5496' } };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    });

    ws.addRow(cols.map(c => sample[c.key] ?? ''));

    const thin = { style: 'thin', color: { argb: 'FFB0B7C3' } };
    ws.eachRow(row => {
      row.eachCell(cell => {
        cell.border = { top: thin, left: thin, bottom: thin, right: thin };
        if (cell.row !== 1) cell.alignment = { vertical: 'top', wrapText: true };
      });
    });

    cols.forEach((c, i) => {
      if (!c.list) return;
      const colLetter = ws.getColumn(i + 1).letter;
      ws.getCell(`${colLetter}2`).dataValidation = {
        type: 'list', allowBlank: true, formulae: [`"${c.list.join(',')}"`]
      };
    });

    ws.views = [{ state: 'frozen', ySplit: 1 }];

    const buf = await wb.xlsx.writeBuffer();
    downloadBlob(buf, 'Template_Import_TestCase.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    Toast.show('Template import Excel diunduh.', 'success');
  },

  bindStaticEvents(){
    const dz = document.getElementById('importDropzone');
    const input = document.getElementById('importFileInput');
    dz.addEventListener('click', () => input.click());
    input.addEventListener('change', e => {
      if (e.target.files[0]){
        TestCaseModule.importFile(e.target.files[0]);
        App.goTo('testcase');
      }
      e.target.value = '';
    });
    ['dragenter','dragover'].forEach(evt => dz.addEventListener(evt, e => { e.preventDefault(); dz.classList.add('dragover'); }));
    ['dragleave','drop'].forEach(evt => dz.addEventListener(evt, e => { e.preventDefault(); dz.classList.remove('dragover'); }));
    dz.addEventListener('drop', e => {
      if (e.dataTransfer.files[0]){
        TestCaseModule.importFile(e.dataTransfer.files[0]);
        App.goTo('testcase');
      }
    });
    document.getElementById('importTemplateBtn').addEventListener('click', () => this.downloadTemplate());
  }
};

document.addEventListener('DOMContentLoaded', () => ImportPage.bindStaticEvents());
