import { useMemo, useRef, useState } from 'react'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import logo from './assets/company-logo.png'
import './App.css'

const defaultTender = {
  tender_id: 'T-2026-0417',
  title: 'Supply of IT Equipment',
  procuring_entity: 'Directorate of Sample Services',
  bidder: 'Meghna Tech Solutions Ltd.',
  submission_deadline: '2026-10-20',
}

const normalizeDuplicateMarkers = (items) => {
  const groupMap = new Map()

  for (const item of items) {
    const existing = groupMap.get(item.hash)
    if (existing) {
      existing.push(item.id)
    } else {
      groupMap.set(item.hash, [item.id])
    }
  }

  return items.map((item) => {
    const groupIds = groupMap.get(item.hash) || []
    const primaryId = groupIds[0]
    const isDuplicate = groupIds.length > 1 && item.id !== primaryId

    return {
      ...item,
      duplicateGroup: primaryId,
      isDuplicate,
    }
  })
}

const parseDateValue = (value) => {
  if (!value) return null

  const [year, month, day] = value.split('-').map(Number)
  if (!year || !month || !day) return null

  return new Date(year, month - 1, day)
}

const sha256 = async (buffer) => {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(hashBuffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

const getStatusText = (requirement, matchedFile, expiryDate, deadline) => {
  if (!matchedFile) {
    return requirement.mandatory
      ? { label: 'Missing', blocking: true }
      : { label: 'Not provided', blocking: false }
  }

  if (requirement.has_expiry) {
    if (!expiryDate) {
      return { label: 'Expiry date needed', blocking: true }
    }

    const expiryDateValue = parseDateValue(expiryDate)
    if (expiryDateValue && expiryDateValue < parseDateValue(deadline)) {
      return { label: 'Expired', blocking: true }
    }
  }

  return { label: 'OK', blocking: false }
}

function App() {
  const [language, setLanguage] = useState('en')
  const [tender, setTender] = useState(defaultTender)
  const [requirements, setRequirements] = useState([])
  const [uploadedFiles, setUploadedFiles] = useState([])
  const [matchMap, setMatchMap] = useState({})
  const [expiryMap, setExpiryMap] = useState({})
  const [notice, setNotice] = useState('Upload requirements.json and the tender PDFs to begin.')
  const [error, setError] = useState('')
  const [isGenerating, setIsGenerating] = useState(false)
  const fileInputRef = useRef(null)

  const orderedRequirements = useMemo(
    () => [...requirements].sort((a, b) => a.order - b.order),
    [requirements],
  )

  const detailRows = useMemo(() => {
    return orderedRequirements.map((requirement) => {
      const matchedFileId = matchMap[requirement.id]
      const matchedFile = uploadedFiles.find((file) => file.id === matchedFileId) || null
      const expiryDate = expiryMap[requirement.id] || ''
      const status = getStatusText(
        requirement,
        matchedFile,
        expiryDate,
        tender.submission_deadline,
      )

      return {
        ...requirement,
        matchedFile,
        expiryDate,
        status,
      }
    })
  }, [expiryMap, matchMap, orderedRequirements, tender.submission_deadline, uploadedFiles])

  const blockingRequirements = useMemo(
    () =>
      detailRows.filter((row) => row.status.blocking).map((row) => ({
        id: row.id,
        title: row.title_en,
      })),
    [detailRows],
  )

  const canGeneratePackage =
    orderedRequirements.length > 0 && detailRows.every((row) => !row.status.blocking)

  const readJsonFile = async (file) => {
    try {
      const parsed = JSON.parse(await file.text())
      if (!parsed || !parsed.tender || !Array.isArray(parsed.requirements)) {
        throw new Error('requirements.json was not in the expected format.')
      }

      setTender(parsed.tender)
      setRequirements(parsed.requirements)
      setUploadedFiles([])
      setMatchMap({})
      setExpiryMap({})
      setNotice('Requirements loaded. Now upload the matching PDF files.')
      setError('')
    } catch (loadError) {
      setError(loadError.message || 'The file could not be read as a valid JSON document.')
    }
  }

  const handleJsonUpload = async (event) => {
    const file = event.target.files?.[0]
    if (!file) return

    await readJsonFile(file)
    event.target.value = ''
  }

  const handlePdfUpload = async (event) => {
    const files = Array.from(event.target.files || [])
    if (!files.length) return

    const earlierFiles = [...uploadedFiles]
    const newItems = []

    for (const file of files) {
      const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')
      if (!isPdf) {
        setError(`${file.name} is not a PDF document. Only PDF files are allowed.`)
        continue
      }

      try {
        const arrayBuffer = await file.arrayBuffer()
        const pdfDoc = await PDFDocument.load(arrayBuffer)
        const pages = pdfDoc.getPageCount()
        const hash = await sha256(arrayBuffer)
        const existingMatch = earlierFiles.find((item) => item.hash === hash)

        newItems.push({
          id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          name: file.name,
          file,
          pages,
          hash,
          size: file.size,
          duplicateGroup: existingMatch ? existingMatch.duplicateGroup || existingMatch.id : null,
          isDuplicate: Boolean(existingMatch),
        })
      } catch (uploadError) {
        setError(
          `${file.name} could not be opened as a valid PDF. It may be damaged or password protected.`,
        )
      }
    }

    if (newItems.length) {
      const merged = normalizeDuplicateMarkers([...earlierFiles, ...newItems])
      setUploadedFiles(merged)
      setNotice('PDF files uploaded. Match them to the tender requirements, then validate the package.')
      setError('')
    }

    event.target.value = ''
  }

  const removeUploadedFile = (fileId) => {
    setUploadedFiles((currentFiles) => {
      const nextFiles = currentFiles.filter((item) => item.id !== fileId)
      return normalizeDuplicateMarkers(nextFiles)
    })

    setMatchMap((currentMap) => {
      const nextMap = { ...currentMap }
      Object.keys(nextMap).forEach((requirementId) => {
        if (nextMap[requirementId] === fileId) {
          delete nextMap[requirementId]
        }
      })
      return nextMap
    })

    setExpiryMap((currentMap) => {
      const nextMap = { ...currentMap }
      Object.keys(nextMap).forEach((requirementId) => {
        const assignmentId = matchMap[requirementId]
        if (assignmentId === fileId) {
          delete nextMap[requirementId]
        }
      })
      return nextMap
    })
  }

  const handleMatchChange = (requirementId, fileId) => {
    const file = uploadedFiles.find((item) => item.id === fileId)
    if (file && file.isDuplicate) {
      setError('Duplicate files are locked to the original copy and cannot be assigned to a different requirement.')
      return
    }

    setMatchMap((currentMap) => {
      const nextMap = { ...currentMap }
      const movingFileIds = Object.keys(nextMap).filter(
        (key) => nextMap[key] === fileId && key !== requirementId,
      )

      movingFileIds.forEach((key) => {
        delete nextMap[key]
      })

      if (!fileId) {
        delete nextMap[requirementId]
      } else {
        nextMap[requirementId] = fileId
      }

      return nextMap
    })
  }

  const handleExpiryChange = (requirementId, value) => {
    setExpiryMap((currentMap) => ({
      ...currentMap,
      [requirementId]: value,
    }))
  }

  const formatVisibleName = (requirement) => {
    return language === 'bn' ? requirement.title_bn : requirement.title_en
  }

  const generatePackage = async () => {
    if (orderedRequirements.length === 0) {
      setError('Load a valid requirements.json file before generating a package.')
      return
    }

    if (!canGeneratePackage) {
      setError('The package cannot be created until all blocking issues are resolved.')
      return
    }

    try {
      setIsGenerating(true)
      setError('')

      const doc = await PDFDocument.create()
      const font = await doc.embedFont(StandardFonts.Helvetica)
      const bold = await doc.embedFont(StandardFonts.HelveticaBold)
      const logoImageBytes = await fetch(logo).then((response) => response.arrayBuffer())
      const logoImage = await doc.embedPng(logoImageBytes)
      const pageSize = [595.28, 841.89]
      const coverPage = doc.addPage(pageSize)

      coverPage.drawImage(logoImage, {
        x: 235,
        y: 650,
        width: 120,
        height: 120,
      })

      coverPage.drawText(tender.tender_id, {
        x: 70,
        y: 560,
        size: 26,
        font: bold,
        color: rgb(0.08, 0.14, 0.19),
      })

      coverPage.drawText(tender.title, {
        x: 70,
        y: 520,
        size: 22,
        font: bold,
        color: rgb(0.08, 0.14, 0.19),
      })

      const fieldLines = [
        ['Procuring entity', tender.procuring_entity],
        ['Bidder', tender.bidder],
        ['Submission deadline', tender.submission_deadline],
        ['Package date', new Date().toISOString().slice(0, 10)],
      ]

      let yCursor = 468
      for (const [label, value] of fieldLines) {
        coverPage.drawText(`${label}: ${value}`, {
          x: 70,
          y: yCursor,
          size: 12,
          font,
          color: rgb(0.18, 0.18, 0.18),
        })
        yCursor -= 26
      }

      coverPage.drawText('Included documents:', {
        x: 70,
        y: 308,
        size: 16,
        font: bold,
        color: rgb(0.08, 0.14, 0.19),
      })

      const includedDocuments = orderedRequirements.filter((requirement) => {
        const matchedFileId = matchMap[requirement.id]
        return Boolean(matchedFileId && uploadedFiles.some((file) => file.id === matchedFileId))
      })

      let insideY = 280
      for (let index = 0; index < includedDocuments.length; index += 1) {
        const item = includedDocuments[index]
        coverPage.drawText(`${index + 1}. ${item.title_en}`, {
          x: 90,
          y: insideY,
          size: 12,
          font,
          color: rgb(0.18, 0.18, 0.18),
        })
        insideY -= 20
      }

      for (const requirement of includedDocuments) {
        const matchedFileId = matchMap[requirement.id]
        const matchedFile = uploadedFiles.find((file) => file.id === matchedFileId)
        if (!matchedFile) continue

        const sourcePdf = await PDFDocument.load(await matchedFile.file.arrayBuffer())
        const copiedPages = await doc.copyPages(sourcePdf, sourcePdf.getPageIndices())
        copiedPages.forEach((page) => doc.addPage(page))
      }

      const totalPages = doc.getPageCount()
      const pages = doc.getPages()
      for (let index = 0; index < pages.length; index += 1) {
        const page = pages[index]
        const footerText = `${tender.tender_id} | Page ${index + 1} of ${totalPages}`
        const marginX = 60
        const textWidth = font.widthOfTextAtSize(footerText, 10)
        const x = (page.getWidth() - textWidth) / 2

        page.drawLine({
          start: { x: marginX, y: 36 },
          end: { x: page.getWidth() - marginX, y: 36 },
          thickness: 1,
          color: rgb(0.86, 0.86, 0.86),
        })

        page.drawText(footerText, {
          x,
          y: 18,
          size: 10,
          font,
          color: rgb(0.3, 0.3, 0.3),
        })
      }

      const pdfBytes = await doc.save()
      const blob = new Blob([pdfBytes], { type: 'application/pdf' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `${tender.tender_id}_Package.pdf`
      anchor.click()
      URL.revokeObjectURL(url)

      setNotice(`Generated ${tender.tender_id}_Package.pdf successfully.`)
    } catch (generateError) {
      setError(generateError.message || 'The package could not be generated.')
    } finally {
      setIsGenerating(false)
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <img src={logo} alt="Company logo" className="brand-logo" />
          <div>
            <p className="eyebrow">AI DevFest</p>
            <h1>Tender Document Package Builder</h1>
          </div>
        </div>

        <div className="controls">
          <label className="file-input-label">
            <span>Load requirements.json</span>
            <input type="file" accept="application/json" onChange={handleJsonUpload} />
          </label>

          <label className="file-input-label secondary">
            <span>Upload PDFs</span>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/pdf"
              multiple
              onChange={handlePdfUpload}
            />
          </label>

          <div className="lang-toggle" aria-label="Language switcher">
            <button
              type="button"
              className={language === 'en' ? 'active' : ''}
              onClick={() => setLanguage('en')}
            >
              EN
            </button>
            <button
              type="button"
              className={language === 'bn' ? 'active' : ''}
              onClick={() => setLanguage('bn')}
            >
              BN
            </button>
          </div>
        </div>
      </header>

      <main className="app-body">
        <section className="info-panel card">
          <div className="panel-header">
            <h2>Tender details</h2>
          </div>
          <div className="tender-grid">
            <div>
              <span className="label">Tender ID</span>
              <strong>{tender.tender_id}</strong>
            </div>
            <div>
              <span className="label">Title</span>
              <strong>{tender.title}</strong>
            </div>
            <div>
              <span className="label">Procuring entity</span>
              <strong>{tender.procuring_entity}</strong>
            </div>
            <div>
              <span className="label">Bidder</span>
              <strong>{tender.bidder}</strong>
            </div>
            <div>
              <span className="label">Submission deadline</span>
              <strong>{tender.submission_deadline}</strong>
            </div>
          </div>
        </section>

        <section className="workspace-grid">
          <div className="card">
            <div className="panel-header">
              <h2>Required documents</h2>
              <span>{orderedRequirements.length} items</span>
            </div>

            {orderedRequirements.length === 0 ? (
              <p className="empty-state">Load a requirements.json file to see the document checklist.</p>
            ) : (
              <div className="requirements-table">
                {detailRows.map((row) => (
                  <div key={row.id} className="requirement-row">
                    <div className="requirement-header">
                      <span className="doc-id">{row.id}</span>
                      <h3>{formatVisibleName(row)}</h3>
                    </div>

                    <div className="assignment-controls">
                      <label>
                        <span>Match</span>
                        <select
                          value={row.matchedFile ? row.matchedFile.id : ''}
                          onChange={(event) => handleMatchChange(row.id, event.target.value || '')}
                        >
                          <option value="">Select file...</option>
                          {uploadedFiles.map((file) => (
                            <option
                              key={file.id}
                              value={file.id}
                              disabled={file.isDuplicate && file.id !== row.matchedFile?.id}
                            >
                              {file.name}
                              {file.isDuplicate ? ' (duplicate)' : ''}
                            </option>
                          ))}
                        </select>
                      </label>

                      {row.has_expiry ? (
                        <label>
                          <span>Expiry</span>
                          <input
                            type="date"
                            value={row.expiryDate}
                            disabled={!row.matchedFile}
                            onChange={(event) => handleExpiryChange(row.id, event.target.value)}
                          />
                        </label>
                      ) : (
                        <div className="mini-note">No expiry check</div>
                      )}
                    </div>

                    <div className={`status-pill ${row.status.blocking ? 'danger' : 'ok'}`}>
                      {row.status.label}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card upload-panel">
            <div className="panel-header">
              <h2>Uploaded files</h2>
              <span>{uploadedFiles.length} files</span>
            </div>

            {uploadedFiles.length === 0 ? (
              <p className="empty-state">No PDF files uploaded yet.</p>
            ) : (
              <ul className="upload-list">
                {uploadedFiles.map((file) => (
                  <li key={file.id} className={file.isDuplicate ? 'duplicate-item' : ''}>
                    <div>
                      <strong>{file.name}</strong>
                      <small>{file.pages} pages</small>
                      {file.isDuplicate && <span className="duplicate-badge">Duplicate</span>}
                    </div>
                    <button type="button" onClick={() => removeUploadedFile(file.id)}>
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="action-box">
              <button
                type="button"
                className="generate-button"
                onClick={generatePackage}
                disabled={isGenerating || !canGeneratePackage}
              >
                {isGenerating ? 'Generating package...' : 'Generate package'}
              </button>

              <div className="status-summary">
                {blockingRequirements.length > 0 ? (
                  <p className="blocking-copy">
                    Blocking issues:
                    {' '}
                    {blockingRequirements.map((item) => item.title).join(', ')}
                  </p>
                ) : (
                  <p className="ready-copy">Ready to create the final PDF package.</p>
                )}
              </div>
            </div>
          </div>
        </section>

        {notice && <div className="info-banner">{notice}</div>}
        {error && <div className="error-banner">{error}</div>}
      </main>
    </div>
  )
}

export default App
