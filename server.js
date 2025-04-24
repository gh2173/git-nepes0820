const express = require('express');
const ExcelJS = require("exceljs");
const app = express();
const path = require('path');
const fs = require('fs');
const { createCanvas } = require('canvas');
const bodyParser = require('body-parser');
const oracledb = require('oracledb');
const ftp = require('basic-ftp');
const session = require('express-session');
const XLSX = require('xlsx');
const puppeteer = require("puppeteer");

oracledb.initOracleClient();

// 정적 파일 제공 설정 및 캐시 제어
app.use('/public', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
}, express.static(path.join(__dirname, 'public')));

app.use('/tailwindcss', express.static(path.join(__dirname, 'tailwindcss')));


// const cacheControl = (req, res, next) => {
//     res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
//     res.setHeader('Pragma', 'no-cache');
//     res.setHeader('Expires', '0');
//     next();
// };

// app.use('/public', cacheControl);
// app.use('/public', express.static(path.join(__dirname, 'public')));

// app.use('/public', cacheControl, express.static(path.join(__dirname, 'public')));

const dbConfig1 = {
    user: 'RPA',
    password: 'rpa01!',
    connectString: '192.168.223.13:1521/ERPSIMAX'
};

async function downloadFileFromFTP(remotePath, localPath) {
    const client = new ftp.Client();
    client.ftp.verbose = true;
    try {
        await client.access({
            host: "192.168.223.23",
            user: "hyperauto",
            password: "Gkdlvj123!@#",
            secure: false
        });
        await client.downloadTo(localPath, remotePath);
    } catch (error) {
        console.error('FTP download error:', error);
        throw error;
    }
    client.close();
}

async function fetchImagesFromFTP(lotId) {
    const client = new ftp.Client();
    client.ftp.verbose = true;
    try {
        await client.access({
            host: "192.168.223.23",
            user: "hyperauto",
            password: "Gkdlvj123!@#",
            secure: false
        });

        const basePath = `/RPA/probemark_Image/CONVERSION/${lotId}/`;
        const folders = await client.list(basePath);
        if (folders.length === 0) {
            throw new Error('No folders found');
        }
        const latestFolder = folders.sort((a, b) => b.name.localeCompare(a.name))[0].name;
        const lotPath = `${basePath}${latestFolder}/`;

        const subFolders = await client.list(lotPath);
        if (subFolders.length === 0) {
            throw new Error('No subfolders found');
        }
        const latestSubFolder = subFolders.sort((a, b) => b.name.localeCompare(a.name))[0].name;
        const imagePath = `${lotPath}${latestSubFolder}/`;

        const files = await client.list(imagePath);
        const bmpFiles = files.filter(file => file.name.endsWith('.bmp'));

        return bmpFiles.map(file => ({
            name: file.name,
            path: `ftp://192.168.223.23${imagePath}${file.name}`
        }));
    } catch (error) {
        console.error('FTP fetch error:', error);
        throw error;
    } finally {
        client.close();
    }
}


app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.json());

app.use(session({
    secret: 'your_secret_key',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: false,
        httpOnly: true,
        maxAge: 3600000
    }
}));

app.listen(8080, '0.0.0.0', function () {
    console.log('Server is running on http://<server-ip>:8080');
});

function isAuthenticated(req, res, next) {
    if (req.session && req.session.userId) {
        return next();
    } else {
        res.redirect('/login_RPA');
    }
}

app.get('/login_RPA', function (req, res) {
    res.sendFile(path.join(__dirname, 'RPA_login.html'));
});

app.get('/login', async function (req, res) {
    const { userId, password } = req.query;

    console.log('Login request received:', { userId, password });

    const query = `
        SELECT USER_ID, USER_NAME, GW_DEPT_NAME, GW_USER_POSITION,
               'nepes_' || SUBSTR(user_id, -4) AS USER_PW
        FROM (
            SELECT a.*, 
                   ROW_NUMBER() OVER (PARTITION BY a.USER_ID, a.USER_NAME ORDER BY a.GW_IF_TIME DESC) AS rn
            FROM RPA_ADMIN.view_userinfo a
        ) tmp
        WHERE rn = 1
          --AND EMAIL IS NOT NULL
          AND GW_DEPT_NAME in ('제조1파트','제조2파트','하이퍼오토메이션팀')
          AND GW_USER_POSITION NOT LIKE 'S%'
          AND USER_ID = :userId
    `;

    try {
        const connection = await oracledb.getConnection(dbConfig1);
        const result = await connection.execute(query, [userId]);
        await connection.close();

        console.log('Database query result:', result);

        if (result.rows.length === 0) {
            res.json({ success: false, message: '계정 정보가 없습니다. 관리자에게 문의하세요.' });
        } else {
            const dbUserPw = result.rows[0][4];
            const userName = result.rows[0][1];
            console.log('Generated USER_PW:', dbUserPw);
            if (dbUserPw === password) {
                req.session.userId = userId;
                req.session.userName = userName; // USER_NAME을 세션에 저장
                res.json({ success: true });
            } else {
                res.json({ success: false, message: 'PASSWORD를 확인해주세요.' });
            }
        }
    } catch (error) {
        console.error('Database error:', error.message);
        res.status(500).json({ success: false, message: `Database error: ${error.message}` });
    }
});


// 사용자 정보를 반환하는 API 엔드포인트 추가
app.get('/user_info', function (req, res) {
    if (req.session.userName) {
        res.json({ userName: req.session.userName });
    } else {
        res.status(401).json({ message: '로그인 필요' });
    }
});

app.post('/logout', function(req, res) {
    req.session.destroy(function(err) {
        if(err) {
            console.error('세션 삭제 중 오류 발생:', err);
            res.status(500).json({ success: false, message: '로그아웃 실패' });
        } else {
            res.clearCookie('connect.sid');
            res.json({ success: true, message: '로그아웃 성공' });
        }
    });
});

app.use('/Ark_RPA_Control_system', isAuthenticated);

app.get('/Ark_RPA_Control_system', function (req, res) {
    res.sendFile(path.join(__dirname, 'RPA_index.html'));
});

// Report.html 파일을 제공하는 엔드포인트 추가
app.get('/report', function (req, res) {
    res.sendFile(path.join(__dirname, 'Report.html'));
});

app.get('/getSummaryReport', async function (req, res) {
    try {
        const connection = await oracledb.getConnection(dbConfig1);
        const result = await connection.execute(`
            SELECT ID,
                   START_TIME,
                   END_TIME,
                   RUN_TIME,
                   SORT_TYPE,
                   MACHINE,
                   LOT_ID,
                   SLOT,
                   STEP,
                   DEVICE_PPID,
                   TOP_POSITION,
                   CENTER_POSITION,
                   BOTTOM_POSITION,
                   LEFT_POSITION,
                   RIGHT_POSITION,
                   SETUP_DIE,
                   OD_VALUE,
                   FIRST_DIE_XY,
                   WAFER_LOADING_POS_X,
                   WAFER_LOADING_POS_Y,
                   WAFER_LOADING_POS_Z,
                   POLYGON_TYPE,
                   VERTEX_LENGTH,
                   SANDING_COUNT,
                   SANDING_OD,
                   PROBE_CARD_DEPTH,
                   WAFER_ALIGN_VALUE_X,
                   WAFER_ALIGN_VALUE_Y,
                   PIN_ALIGN_VALUE_Z,
                   WAFER_SETUP_FLATNESS,
                   CREATED_DATE
            FROM RPA_ADMIN.summareport
            ORDER BY ID DESC
        `);

        const rows = result.rows.map(row => ({
            ID: row[0],
            START_TIME: row[1],
            END_TIME: row[2],
            RUN_TIME: row[3],
            SORT_TYPE: row[4],
            MACHINE: row[5],
            LOT_ID: row[6],
            SLOT: row[7],
            STEP: row[8],
            DEVICE_PPID: row[9],
            TOP_POSITION: row[10],
            CENTER_POSITION: row[11],
            BOTTOM_POSITION: row[12],
            LEFT_POSITION: row[13],
            RIGHT_POSITION: row[14],
            SETUP_DIE: row[15],
            OD_VALUE: row[16],
            FIRST_DIE_XY: row[17],
            WAFER_LOADING_POS_X: row[18],
            WAFER_LOADING_POS_Y: row[19],
            WAFER_LOADING_POS_Z: row[20],
            POLYGON_TYPE: row[21],
            VERTEX_LENGTH: row[22],
            SANDING_COUNT: row[23],
            SANDING_OD: row[24],
            PROBE_CARD_DEPTH: row[25],
            WAFER_ALIGN_VALUE_X: row[26],
            WAFER_ALIGN_VALUE_Y: row[27],
            PIN_ALIGN_VALUE_Z: row[28],
            WAFER_SETUP_FLATNESS: row[29],
            CREATED_DATE: row[30]
        }));

        res.json(rows);
        await connection.close();
    } catch (error) {
        console.error('Database error:', error);
        res.status(500).send('Error fetching data from database');
    }
});

app.get('/getImage', function (req, res) {
    const filePath = path.join(__dirname, 'nepesark_2-removebg-preview.png');
    fs.readFile(filePath, function (err, data) {
        if (err) {
            console.error('File read error:', err);
            res.status(500).send('파일을 읽는 중 오류가 발생했습니다.');
        } else {
            res.setHeader('Content-Type', 'image/png');
            res.setHeader('Content-Disposition', 'inline; filename=nepesark_2-removebg-preview.png');
            res.send(data);
        }
    });
});

app.get('/getImage2', function (req, res) {
    const filePath = path.join(__dirname, 'RPA_image.jpg');
    fs.readFile(filePath, function (err, data) {
        if (err) {
            console.error('File read error:', err);
            res.status(500).send('파일을 읽는 중 오류가 발생했습니다.');
        } else {
            res.setHeader('Content-Type', 'image/jpeg');
            res.setHeader('Content-Disposition', 'inline; filename=nepesark_2.jpg');
            res.send(data);
        }
    });
});


async function getDataFromDB1() {
    let connection;
    try {
        connection = await oracledb.getConnection(dbConfig1);
        const result = await connection.execute(`
            SELECT 
                i.STATUS,
                i.EQPID,
                i.DEVICE,
                i.LOT_ID,
                i.STEP_ID,
                i.PC_ID,
                i.PB_ID,
                i.USER_ID,
                TO_CHAR(r.START_TIME, 'YYYY-MM-DD HH24:MI:SS') AS DATE_,
                i.IP,
                ROWNUM,
                r.RPA_STATUS,
                r.PROGRESS,
                r.PG_DETAIL,
                r.FINALLY,
                r.USERID
            FROM 
                (SELECT 
                    STATUS, EQPID, DEVICE, LOT_ID, STEP_ID, PC_ID, PB_ID, USER_ID, DATE_, IP,
                    ROW_NUMBER() OVER (PARTITION BY EQPID ORDER BY DATE_ DESC) AS rn
                FROM RPA_ADMIN.INTERFACE) i
            LEFT JOIN 
                (SELECT 
                    EQP_ID, SORT_STATUS, LOT_ID, RPA_STATUS, PROGRESS, PG_DETAIL, FINALLY, USERID, START_TIME,
                    ROW_NUMBER() OVER (PARTITION BY EQP_ID ORDER BY START_TIME DESC) AS rn
                FROM RPA_ADMIN.RPA) r
            ON i.EQPID = r.EQP_ID 
            AND i.STATUS = r.SORT_STATUS 
            AND i.LOT_ID = r.LOT_ID
            WHERE i.rn = 1 AND r.rn = 1 AND r.FINALLY != 'Ok'
            ORDER BY i.EQPID ASC
        `);
        return result.rows.map(row => ({
            STATUS: row[0],
            EQPID: row[1],
            DEVICE: row[2],
            LOT_ID: row[3],
            STEP_ID: row[4],
            PC_ID: row[5],
            PB_ID: row[6],
            USER_ID: row[7],
            DATE_: row[8],
            IP: row[9],
            ROWNUM: row[10],
            RPA_STATUS: row[11],
            PROGRESS: row[12],
            PG_DETAIL: row[13],
            FINALLY: row[14], // FINALLY 컬럼 추가
            USERID: row[15]
        }));
    } catch (err) {
        console.error(err);
        throw err;
    } finally {
        if (connection) {
            try {
                await connection.close();
            } catch (err) {
                console.error(err);
            }
        }
    }
}

app.get('/getMonitoringData', async function (req, res) {
    try {
        const data = await getDataFromDB1();
        res.json(data);
    } catch (err) {
        res.status(500).send('Error fetching data');
    }
});

app.get('/getWaitData', async function (req, res) {
    try {
        const data = await getWaitDataFromDB1();
        res.json(data);
    } catch (err) {
        res.status(500).send('Error fetching data');
    }
});

// 최종 리포트 이미지 가져오기
app.get('/viewExcelSheet', async function (req, res) {
    if (!globalItem || !globalItem.STATUS || !globalItem.LOT_ID || !globalItem.EQPID) {
        return res.status(400).send('STATUS, LOT_ID 또는 DEVICE 정보가 설정되지 않았습니다.');
    }

    const basePath = `/RPA/Report/${globalItem.STATUS}/`;
    const client = new ftp.Client();
    client.ftp.verbose = true;
    const localPath = path.join(__dirname, 'temp.xlsx');

    try {
        await client.access({
            host: "192.168.223.23",
            user: "hyperauto",
            password: "Gkdlvj123!@#",
            secure: false
        });

        // 해당 경로의 파일 목록 가져오기
        const files = await client.list(basePath);
        const matchingFiles = files.filter(file => file.name.startsWith(`${globalItem.LOT_ID}_${globalItem.EQPID}_${globalItem.STATUS}_`) && file.name.endsWith('.xlsx'));

        if (matchingFiles.length === 0) {
            throw new Error('No matching files found');
        }

        // 가장 최신 날짜의 파일 찾기
        const latestFile = matchingFiles.sort((a, b) => b.name.localeCompare(a.name))[0].name;
        const remotePath = `${basePath}${latestFile}`;

        await client.downloadTo(localPath, remotePath);

        // 파일이 존재하는지 확인
        if (!fs.existsSync(localPath)) {
            throw new Error(`File not found: ${localPath}`);
        }

        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(localPath);
        const worksheet = workbook.getWorksheet(2); // 두 번째 시트

        // B2:S33 범위를 HTML로 변환
        let html = '<table border="1" style="border-collapse: collapse; text-align: center; width: 100%;">';
        const merges = worksheet._merges;
        for (let rowNumber = 2; rowNumber <= 33; rowNumber++) {
            const row = worksheet.getRow(rowNumber);
            const isLastRow = rowNumber === 33; // 마지막 행인지 확인
            html += `<tr${isLastRow ? ' style="background-color: yellow;"' : ''}>`;
            for (let colNumber = 2; colNumber <= 19; colNumber++) {
                const cell = row.getCell(colNumber);
                const cellValue = cell.value || '';
                const cellAddress = cell.address;

                // 병합된 셀 확인
                const mergeCell = merges[cellAddress];
                if (mergeCell) {
                    const { top, left, bottom, right } = mergeCell;
                    const rowspan = bottom - top + 1;
                    const colspan = right - left + 1;
                    html += `<td rowspan="${rowspan}" colspan="${colspan}" style="border: 1px solid black;">${cellValue}</td>`;
                } else {
                    // 병합된 셀의 시작 셀만 값을 표시하고 나머지 셀은 비워둠
                    const isMerged = Object.values(merges).some(merge => {
                        const { top, left, bottom, right } = merge;
                        return rowNumber >= top && rowNumber <= bottom && colNumber >= left && colNumber <= right;
                    });
                    if (!isMerged) {
                        html += `<td style="border: 1px solid black;">${cellValue}</td>`;
                    }
                }
            }
            html += '</tr>';
        }
        html += '</table>';

        res.send(html);
    } catch (error) {
        console.error('Error processing Excel file:', error);
        res.status(500).send('Error processing Excel file');
    } finally {
        client.close();
        if (fs.existsSync(localPath)) {
            fs.unlinkSync(localPath); // 임시 파일 삭제
        }
    }
});

app.use(express.static(path.join(__dirname, 'public')));

// Probemark 이미지 다운로드
app.get('/fetchImages', async function (req, res) {
    if (!globalItem || !globalItem.STATUS || !globalItem.LOT_ID) {
        return res.status(400).send('STATUS 또는 LOT_ID 정보가 설정되지 않았습니다.');
    }

    const basePath = `/RPA/probemark_Image/${globalItem.STATUS}/${globalItem.LOT_ID}/`;
    const client = new ftp.Client();
    client.ftp.verbose = true;

    try {
        await client.access({
            host: "192.168.223.23",
            user: "hyperauto",
            password: "Gkdlvj123!@#",
            secure: false
        });

        // LOT_ID 뒤에 붙는 숫자가 가장 큰 폴더 찾기
        const lotFolders = await client.list(basePath);
        const latestLotFolder = lotFolders
            .filter(folder => folder.name.startsWith(globalItem.LOT_ID + '.'))
            .sort((a, b) => parseInt(b.name.split('.')[1]) - parseInt(a.name.split('.')[1]))[0].name;

        const lotPath = `${basePath}${latestLotFolder}/`;

        // 가장 최신 날짜&시간 폴더 찾기
        const dateFolders = await client.list(lotPath);
        const latestDateFolder = dateFolders
            .sort((a, b) => b.name.localeCompare(a.name))[0].name;

        const remotePath = `${lotPath}${latestDateFolder}/`;
        const localDir = path.join(__dirname, 'public', 'images');

        const files = await client.list(remotePath);
        const bmpFiles = files.filter(file => file.name.endsWith('.bmp'));

        // Ensure local directory exists
        if (!fs.existsSync(localDir)) {
            fs.mkdirSync(localDir, { recursive: true });
        }

        // Download images to local directory
        for (const file of bmpFiles) {
            const localPath = path.join(localDir, file.name);
            await client.downloadTo(localPath, `${remotePath}${file.name}`);
        }

        const images = bmpFiles.map(file => ({
            name: file.name,
            path: `/images/${file.name}`
        }));

        res.json(images);
    } catch (error) {
        console.error('Error fetching images:', error);
        res.status(500).send('Error fetching images');
    } finally {
        client.close();
    }
});


// Contact setup 후 Run동작 실행
app.post('/updateStatus', async (req, res) => {
    const { eqpid, startTime } = req.body;

    try {
        const connection = await oracledb.getConnection(dbConfig1);
        const result = await connection.execute(
            `UPDATE RPA_ADMIN.RPA 
             SET RPA_STATUS = 'Run' 
             WHERE EQP_ID = :eqpid 
             AND START_TIME = TO_TIMESTAMP(:startTime, 'YYYY-MM-DD HH24:MI:SS.FF')
             AND RPA_STATUS IN  ('Check', 'Error')`,
            [eqpid, startTime],
            { autoCommit: true }
        );

        if (result.rowsAffected === 0) {
            res.status(404).send('No rows updated');
        } else {
            res.send('Status updated successfully');
        }

        await connection.close();
    } catch (error) {
        console.error('Error updating status:', error);
        res.status(500).send('Error updating status');
    }
});

// STOP 동작 실행
app.post('/updateStatus_2', async (req, res) => {
    const { eqpid, startTime, status, finally: finallyStatus, userId } = req.body;

    try {
        const connection = await oracledb.getConnection(dbConfig1);
        const result = await connection.execute(
            `UPDATE RPA_ADMIN.RPA 
             SET RPA_STATUS = :status, FINALLY = :finallyStatus, USERID = :userId
             WHERE EQP_ID = :eqpid 
             AND START_TIME = TO_TIMESTAMP(:startTime, 'YYYY-MM-DD HH24:MI:SS.FF')
             AND RPA_STATUS IN ('Check', 'Error', 'Run')`,
            [status, finallyStatus, userId, eqpid, startTime],
            { autoCommit: true }
        );

        if (result.rowsAffected === 0) {
            res.status(404).send('No rows updated');
        } else {
            res.send('Status updated successfully');
        }

        await connection.close();
    } catch (error) {
        console.error('Error updating status:', error);
        res.status(500).send('Error updating status');
    }
});

// RPA 완료시 FINALLY 컬럼 값 수정
app.post('/updateFinallyColumn', async (req, res) => {
    const { eqpid, startTime, userId } = req.body;
    console.log('Received request to updateFinallyColumn:', { eqpid, startTime, userId });

    try {
        const connection = await oracledb.getConnection(dbConfig1);
        const result = await connection.execute(
            `UPDATE RPA_ADMIN.RPA 
             SET FINALLY = 'Ok', USERID = :userId
             WHERE EQP_ID = :eqpid
             AND START_TIME = TO_TIMESTAMP(:startTime, 'YYYY-MM-DD HH24:MI:SS.FF')`,
            { eqpid, startTime, userId }, // 바인드 변수 수정
            { autoCommit: true }
        );

        console.log('Update result:', result);

        if (result.rowsAffected === 0) {
            console.log('No rows updated for:', { eqpid, startTime, userId });
            res.status(404).send('No rows updated');
        } else {
            res.json({ success: true, message: 'FINALLY 컬럼 값이 성공적으로 수정되었습니다.' });
        }

        await connection.close();
    } catch (error) {
        console.error('Error updating FINALLY column:', error);
        res.status(500).send('Error updating FINALLY column');
    }
});

// 전역변수 설정
let globalItem = null;

// 특정 엔드포인트에서 globalItem 설정
app.post('/setGlobalItem', (req, res) => {
    globalItem = req.body;
    res.json({ success: true, message: 'globalItem이 설정되었습니다.' });
});

// 한도견본 출력
app.get('/generate-image', async (req, res) => {
    if (!globalItem || !globalItem.DEVICE) {
        return res.status(400).send('DEVICE 정보가 설정되지 않았습니다.');
    }

    const client = new ftp.Client();
    client.ftp.verbose = true;
    const localPath = path.join(__dirname, 'temp.xlsx');
    const device = globalItem.DEVICE; // 전역 변수에서 DEVICE 값을 가져옴

    try {
        await client.access({
            host: "192.168.223.23",
            user: "hyperauto",
            password: "Gkdlvj123!@#",
            secure: false
        });

        const remotePath = `/RPA/제품별한도견본/${device}_한도견본.xlsx`; // DEVICE 값을 기반으로 파일명 설정
        await client.downloadTo(localPath, remotePath);

        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(localPath);
        const worksheet = workbook.getWorksheet(1);

        // A1:A10 범위를 추출 (병합된 셀 고려)
        let textData = [];
        let previousValue = null;
        for (let rowNumber = 1; rowNumber <= 10; rowNumber++) {
            const cell = worksheet.getRow(rowNumber).getCell(1); // A열의 셀 값 추출
            const cellValue = cell.value !== null ? cell.value.toString() : '0'; // 셀 값이 null인 경우 '0'으로 설정
            if (cellValue !== previousValue) {
                textData.push(cellValue);
                previousValue = cellValue;
            }
        }

        // 두 번째 시트에서 이미지 추출
        const secondSheet = workbook.getWorksheet(2);
        let imageData = [];
        const images = secondSheet.getImages();
        images.forEach(image => {
            const { range, imageId } = image;
            const imageBuffer = workbook.model.media.find(media => media.index === imageId).buffer;
            const base64Image = imageBuffer.toString('base64');
            imageData.push(`data:image/png;base64,${base64Image}`);
        });

        res.json({ textData, imageData });
    } catch (error) {
        console.error('Error generating image:', error);
        res.status(500).send('Error generating image');
    } finally {
        client.close();
        if (fs.existsSync(localPath)) {
            fs.unlinkSync(localPath);
        }
    }
});


// async function getBallSize(device) {
//     let connection;
//     try {
//         connection = await oracledb.getConnection(dbConfig1);
//         const result = await connection.execute(
//             `SELECT BALL_SIZE FROM ASFC_BALL_SIZE WHERE DEVICE = :device`,
//             [device]
//         );
//         if (result.rows.length > 0) {
//             return result.rows[0][0]; // BALL_SIZE 값 반환
//         } else {
//             throw new Error('No matching device found');
//         }
//     } catch (err) {
//         console.error('Database error:', err);
//         throw err;
//     } finally {
//         if (connection) {
//             try {
//                 await connection.close();
//             } catch (err) {
//                 console.error('Error closing connection:', err);
//             }
//         }
//     }
// }

// 누적 최종데이터 추출
app.get('/Detailed-Report', async function (req, res) {
    const { fileName, sortValue } = req.query;
    if (!fileName || !sortValue) {
        return res.status(400).send('fileName and sortValue parameters are required');
    }

    const basePath = `/RPA/Report/${sortValue}/`;
    const client = new ftp.Client();
    client.ftp.verbose = true;
    const localPath = path.join(__dirname, 'temp.xlsx');

    try {
        await client.access({
            host: "192.168.223.23",
            user: "hyperauto",
            password: "Gkdlvj123!@#",
            secure: false
        });

        // 해당 경로의 파일 목록 가져오기
        const files = await client.list(basePath);
        console.log('Files in directory:', files); // 파일 목록 로그 출력

        // 파일 이름 비교 로그 추가
        const fileNameOnly = path.basename(fileName); // 경로를 제거한 파일 이름
        files.forEach(file => {
            console.log(`Comparing: ${file.name} with ${fileNameOnly}`);
        });

        const matchingFiles = files.filter(file => file.name === fileNameOnly);
        console.log('Matching files:', matchingFiles); // 매칭되는 파일 로그 출력

        if (matchingFiles.length === 0) {
            throw new Error('No matching files found');
        }

        const remotePath = `${basePath}${fileNameOnly}`;
        console.log(`Attempting to download file from: ${remotePath}`); // 경로를 로그로 출력

        await client.downloadTo(localPath, remotePath);

        // 파일이 존재하는지 확인
        if (!fs.existsSync(localPath)) {
            throw new Error(`File not found: ${localPath}`);
        }

        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(localPath);
        const worksheet = workbook.getWorksheet(2); // 두 번째 시트

        // B2:S58 범위를 HTML로 변환
        let html = '<table border="1" style="border-collapse: collapse; text-align: center; width: 100%;">';
        const merges = worksheet._merges;
        for (let rowNumber = 2; rowNumber <= 58; rowNumber++) {
            const row = worksheet.getRow(rowNumber);
            html += '<tr>';
            for (let colNumber = 2; colNumber <= 19; colNumber++) {
                const cell = row.getCell(colNumber);
                const cellValue = cell.value || '';
                const cellAddress = cell.address;

                // 병합된 셀 확인
                const mergeCell = merges[cellAddress];
                if (mergeCell) {
                    const { top, left, bottom, right } = mergeCell;
                    const rowspan = bottom - top + 1;
                    const colspan = right - left + 1;
                    html += `<td rowspan="${rowspan}" colspan="${colspan}" style="border: 1px solid black;">${cellValue}</td>`;
                } else {
                    // 병합된 셀의 시작 셀만 값을 표시하고 나머지 셀은 비워둠
                    const isMerged = Object.values(merges).some(merge => {
                        const { top, left, bottom, right } = merge;
                        return rowNumber >= top && rowNumber <= bottom && colNumber >= left && colNumber <= right;
                    });
                    if (!isMerged) {
                        html += `<td style="border: 1px solid black;">${cellValue}</td>`;
                    }
                }
            }
            html += '</tr>';
        }
        html += '</table>';

        // 이미지 추출
        const images = worksheet.getImages();
        let imageHtml = '<div style="display: flex; flex-wrap: wrap;">';
        for (const image of images) {
            const imageId = image.imageId;
            const imageBuffer = workbook.model.media.find(media => media.index === imageId).buffer;
            const base64Image = imageBuffer.toString('base64');
            imageHtml += `
                <div style="width: 50%; padding: 10px; box-sizing: border-box;">
                    <div style="border: 1px solid black; padding: 10px;">
                        <img src="data:image/png;base64,${base64Image}" style="width: 100%; height: auto;" />
                    </div>
                </div>`;
        }
        imageHtml += '</div>';

        html += imageHtml;

        res.send(html);
    } catch (error) {
        console.error('Error fetching Excel file:', error);
        res.status(500).send('Error fetching Excel file');
    } finally {
        client.close();
        if (fs.existsSync(localPath)) {
            fs.unlinkSync(localPath); // 임시 파일 삭제
        }
    }
});

// BALL 사이즈 커서변경
app.get('/setCursorStyle', async function (req, res) {
    if (!globalItem || !globalItem.DEVICE) {
        return res.status(400).send('DEVICE 정보가 설정되지 않았습니다.');
    }

    const device = globalItem.DEVICE;

    try {
        const ballSize = await getBallSize(device); // DB에서 BALL_SIZE 값을 가져옴
        const innerCircleSize = ballSize * 0.6;

        const cursorSvg = `
            <svg width="${ballSize}" height="${ballSize}" xmlns="http://www.w3.org/2000/svg">
                <circle cx="${ballSize / 2}" cy="${ballSize / 2}" r="${ballSize / 2}" stroke="green" stroke-width="2" fill="none" />
                <circle cx="${ballSize / 2}" cy="${ballSize / 2}" r="${innerCircleSize / 2}" stroke="red" stroke-width="2" fill="none" />
            </svg>
        `;
        const cursorUrl = `data:image/svg+xml;base64,${Buffer.from(cursorSvg).toString('base64')}`;

        const cursorStyle = `
            #inspection-images-container:hover {
                cursor: url('${cursorUrl}') ${ballSize / 2} ${ballSize / 2}, auto;
            }
        `;
        res.send(cursorStyle);
    } catch (error) {
        console.error('Error setting cursor style:', error);
        res.status(500).send('Error setting cursor style');
    }
});